import type OpenAI from "openai";
import { aiJson, aiStreamText, openai } from "@/lib/ai";
import { retrieveChunks } from "@/lib/rag";
import { approxTokens } from "@/lib/tokens";
import { env } from "@/lib/env";
import type { DocumentTextRow, Role } from "@/lib/types";

/**
 * V2 answer pipeline — one path, maximum quality:
 *   strongest model + FULL document + full thread history + reasoning.
 * The prompt is layered so the static prefix (system -> document) is
 * byte-identical across requests for the same document, and (document ->
 * passage) across a thread — that is what makes provider prompt caching work.
 * Only documents over DOC_FULL_CONTEXT_MAX_TOKENS fall back to RAG.
 */

export const ANSWER_SYSTEM = `You are an expert reading alongside the reader, answering about the passage they highlighted in the document below.
You have the full document; use it freely and cite pages like (p. 4). Quote the text briefly when it helps.
Stay faithful to the document. If something is not in it, say so, then answer from general knowledge if you can, clearly marked as such.
Match the reader's level and the language of their question. If they ask for a simpler explanation, explain simply without talking down to them.
Be as thorough as the question deserves: give the reasoning, an example or consequence where useful, and note important nuances. Do not pad, do not restate the question.
Use light Markdown (bold for key terms, short lists only when they genuinely help).`;

const WEB_ADDENDUM = `You may search the web when the document cannot answer. Keep document-sourced and web-sourced content clearly separated, and cite web sources.`;

/* ------------------------------------------------------- web classifier */

const WEB_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["web"],
  properties: {
    web: {
      type: "boolean",
      description:
        "true ONLY when the question needs information that cannot be inside the document: author background, reception, replication, criticism, later events.",
    },
  },
} as const;

/** Cheap {web} classifier, hard-capped by a timeout — never delays the answer. */
export async function classifyWeb(question: string, docTitle: string): Promise<boolean> {
  const call = aiJson<{ web: boolean }>({
    model: env.modelUtility,
    system:
      "Decide if answering this reader question requires information from OUTSIDE the document itself (people/credibility, reception, replication, events after publication). Output {web:boolean}.",
    input: `Document: "${docTitle}"\nQuestion: "${question.slice(0, 400)}"`,
    effort: "minimal",
    maxOutputTokens: 600,
    schemaName: "web_flag",
    schema: WEB_SCHEMA as unknown as Record<string, unknown>,
  }).then((r) => r.value.web);
  const timeout = new Promise<boolean>((resolve) =>
    setTimeout(() => resolve(false), env.webClassifierTimeoutMs),
  );
  return Promise.race([call, timeout]).catch(() => false);
}

/* ------------------------------------------------------- prompt building */

/** Deterministic full-document block (byte-identical per document). */
export function documentBlock(
  pages: DocumentTextRow[],
  markdown: string | null,
  header: string,
): string {
  const body =
    markdown ?? pages.map((p) => `<!-- page ${p.page_no} -->\n\n${p.text}`).join("\n\n");
  return `${header}\n\n<document>\n${body}\n</document>`;
}

export interface AnswerInput {
  question: string;
  web: boolean;
  /** Static per document. */
  docBlock: string | null; // null => oversized branch
  /** Oversized branch only. */
  oversized?: {
    summaryMd: string | null;
    ragText: string;
    nearPagesText: string;
  };
  /** Static per thread. */
  passageBlock: string;
  history: { role: Role; content: string }[];
  imageDataUrl?: string | null;
}

export function buildAnswerRequest(input: AnswerInput): {
  system: string;
  apiInput: OpenAI.Responses.ResponseInput;
} {
  const system = input.web ? `${ANSWER_SYSTEM}\n\n${WEB_ADDENDUM}` : ANSWER_SYSTEM;

  const staticParts: string[] = [];
  if (input.docBlock) {
    staticParts.push(input.docBlock);
  } else if (input.oversized) {
    staticParts.push(
      "The document is too large to include whole. You get: its map, the pages around the passage in full, and relevant excerpts.",
      input.oversized.summaryMd ? `Document map:\n${input.oversized.summaryMd}` : "",
      `Pages around the passage:\n${input.oversized.nearPagesText}`,
      input.oversized.ragText,
    );
  }
  staticParts.push(input.passageBlock);

  const apiInput: OpenAI.Responses.ResponseInput = [
    { role: "user", content: staticParts.filter(Boolean).join("\n\n") },
    {
      role: "assistant",
      content: "Understood — I have the document and the highlighted passage. What would you like to know?",
    },
    ...input.history.map((m) => ({ role: m.role, content: m.content })),
  ];

  if (input.imageDataUrl) {
    apiInput.push({
      role: "user",
      content: [
        { type: "input_text", text: input.question },
        { type: "input_image", image_url: input.imageDataUrl, detail: "auto" },
      ],
    });
  } else {
    apiInput.push({ role: "user", content: input.question });
  }
  return { system, apiInput };
}

/* --------------------------------------------------------- oversized RAG */

export async function oversizedContext(
  documentId: string,
  question: string,
  pages: DocumentTextRow[],
  anchorPage: number,
  summaryMd: string | null,
): Promise<NonNullable<AnswerInput["oversized"]>> {
  const chunks = await retrieveChunks(documentId, question, 12);
  const ragText =
    chunks.length > 0
      ? "Relevant excerpts:\n" +
        chunks
          .map(
            (c) =>
              `<excerpt pages="${c.page_from}-${c.page_to}"${c.heading ? ` section="${c.heading}"` : ""}>\n${c.text}\n</excerpt>`,
          )
          .join("\n")
      : "";
  const near = pages
    .filter((p) => Math.abs(p.page_no - anchorPage) <= 1)
    .map((p) => `<!-- page ${p.page_no} -->\n\n${p.text}`)
    .join("\n\n");
  return { summaryMd, ragText, nearPagesText: near };
}

/* -------------------------------------------------------------- answering */

export interface AnswerResult {
  text: string;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  };
  ttftMs: number;
  totalMs: number;
  model: string;
}

/** Stream the answer; resolves with text + full observability data. */
export async function streamAnswer(
  input: AnswerInput,
  onDelta: (text: string) => void,
): Promise<AnswerResult> {
  const { system, apiInput } = buildAnswerRequest(input);
  const t0 = Date.now();
  let ttft = 0;

  const stream = openai().responses.stream({
    model: env.modelAnswer,
    instructions: system,
    input: apiInput,
    reasoning: { effort: env.reasoningEffortAnswer },
    max_output_tokens: 16000,
    ...(input.web ? { tools: [{ type: "web_search" as const }] } : {}),
  });
  stream.on("response.output_text.delta", (e) => {
    if (!ttft) ttft = Date.now() - t0;
    onDelta(e.delta);
  });
  const final = await stream.finalResponse();
  const usage = final.usage;
  return {
    text: final.output_text ?? "",
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
    },
    ttftMs: ttft,
    totalMs: Date.now() - t0,
    model: env.modelAnswer,
  };
}

/* ---------------------------------------------------------- observability */

// GPT-5 list prices per 1M tokens; cached input is billed at 10%.
const PRICE = { input: 1.25, cachedInput: 0.125, output: 10 };
const dailyCost = new Map<string, { day: string; usd: number }>();

export function logAnswer(
  userId: string,
  r: AnswerResult,
  extra: { web: boolean; docTokens: number; branch: "full" | "rag" },
): void {
  const usd =
    ((r.usage.inputTokens - r.usage.cachedInputTokens) * PRICE.input +
      r.usage.cachedInputTokens * PRICE.cachedInput +
      r.usage.outputTokens * PRICE.output) /
    1_000_000;
  const day = new Date().toISOString().slice(0, 10);
  const entry = dailyCost.get(userId);
  const total = entry && entry.day === day ? entry.usd + usd : usd;
  dailyCost.set(userId, { day, usd: total });
  console.log(
    `[answer] model=${r.model} branch=${extra.branch} web=${extra.web} docTok=${extra.docTokens} ` +
      `in=${r.usage.inputTokens} cached=${r.usage.cachedInputTokens} out=${r.usage.outputTokens} ` +
      `reason=${r.usage.reasoningTokens} ttft=${r.ttftMs}ms total=${r.totalMs}ms ` +
      `cost=$${usd.toFixed(4)} today(user)=$${total.toFixed(3)}`,
  );
}

export function docTokenCount(pages: DocumentTextRow[]): number {
  return approxTokens(pages.map((p) => p.text).join(""));
}
