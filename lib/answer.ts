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

/* ----------------------------------------------- request classifier */

export type Dose = "low" | "medium" | "high";

export interface RequestPlan {
  web: boolean;
  /** How hard gpt-5 thinks before writing. Never changes WHICH model answers. */
  effort: Dose;
  /** How long the answer runs. */
  verbosity: Dose;
}

const SAFE_PLAN: RequestPlan = { web: false, effort: "medium", verbosity: "medium" };

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["web", "effort", "verbosity"],
  properties: {
    web: {
      type: "boolean",
      description:
        "true ONLY when the question needs information that cannot be inside the document: author background, reception, replication, criticism, later events.",
    },
    effort: { type: "string", enum: ["low", "medium", "high"] },
    verbosity: { type: "string", enum: ["low", "medium", "high"] },
  },
} as const;

const PLAN_SYSTEM = `You tune two dials for the answering model (always the same strong model — you never pick who answers). Output {web, effort, verbosity}.

effort — how deeply it reasons before writing:
- "low": single-step asks — definition, translation, "what does this word/line say", a fact stated plainly in the text.
- "medium" (default): explanations, interpretations, "why", local comparisons.
- "high": multi-step analysis — verify a conclusion against methods/tables, critique an argument, synthesis across the whole document.

verbosity — how long the answer should run:
- "low": single-fact answers and quick clarifications.
- "medium" (default): normal explanations.
- "high": "walk me through", "in depth", broad syntheses.

web: true ONLY when the answer needs information from outside the document (people/credibility, reception, replication, events after publication).

CALIBRATION: when unsure, choose the higher effort. A wasted cent is nothing; a shallow answer to a deep question costs trust. Vague or ambiguous questions are NEVER "low" effort — "low" is reserved for questions that name their exact target.

Examples:
- "what does 'entropy' mean?" -> effort=low (names its exact target)
- "si asta ce vrea sa zica?" / "what's this saying?" -> effort=medium (vague — needs interpretation)
- "does the conclusion follow from the evidence?" -> effort=high`;

/** Explicit asks for MORE depth. "I didn't understand" alone is NOT one —
 * paired with "simply/simple" it asks for LESS complexity, not more depth. */
const WANTS_DEPTH = /mai profund|mai detaliat|in depth|more detail|deeper|explain more|dezvolt/i;
const WANTS_SIMPLE = /\b(simplu|simpla|simple|simply|plain|eli5)\b|pe [îi]n[țt]elesul|mai simplu/i;

/**
 * Cheap parallel planner, hard-capped by a timeout. Failure or timeout can
 * only ever cost money (safe medium plan), never quality.
 */
export async function planRequest(question: string, docTitle: string): Promise<RequestPlan> {
  const call = aiJson<RequestPlan>({
    model: env.modelUtility,
    system: PLAN_SYSTEM,
    input: `Document: "${docTitle}"\nQuestion: "${question.slice(0, 400)}"`,
    effort: "minimal",
    maxOutputTokens: 700,
    schemaName: "request_plan",
    schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
  }).then((r) => r.value);
  const timeout = new Promise<RequestPlan>((resolve) =>
    setTimeout(() => resolve({ ...SAFE_PLAN }), env.webClassifierTimeoutMs),
  );
  const plan = await Promise.race([call, timeout]).catch(() => ({ ...SAFE_PLAN }));

  // Measured calibration (eval/results-dosing.md): planner-chosen "high" cost
  // +50-70% over medium and bought no reliable quality — gpt-5 at medium is
  // already the ceiling. The planner may only dose DOWN; "high" is reserved
  // for the reader explicitly asking for depth (deterministic guard below).
  if (plan.effort === "high") plan.effort = "medium";

  if (WANTS_DEPTH.test(question) && !WANTS_SIMPLE.test(question)) {
    plan.effort = "high";
    if (plan.verbosity === "low") plan.verbosity = "medium";
  }
  return plan;
}

/** Back-compat helper (search route). */
export async function classifyWeb(question: string, docTitle: string): Promise<boolean> {
  return (await planRequest(question, docTitle)).web;
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
  /** Reasoning depth for this request; "medium" maps to the env default. */
  effort?: Dose;
  /** Answer length dial (gpt-5 text.verbosity). */
  verbosity?: Dose;
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
  effort: string;
  verbosity: string;
}

/** Stream the answer; resolves with text + full observability data. */
export async function streamAnswer(
  input: AnswerInput,
  onDelta: (text: string) => void,
): Promise<AnswerResult> {
  const { system, apiInput } = buildAnswerRequest(input);
  const t0 = Date.now();
  let ttft = 0;

  // "medium" is the env-governed default; low/high are explicit doses.
  const effort =
    !input.effort || input.effort === "medium" ? env.reasoningEffortAnswer : input.effort;
  const verbosity = input.verbosity ?? "medium";

  const stream = openai().responses.stream({
    model: env.modelAnswer,
    instructions: system,
    input: apiInput,
    reasoning: { effort },
    text: { verbosity },
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
    effort,
    verbosity,
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
    `[answer] model=${r.model} effort=${r.effort} verb=${r.verbosity} branch=${extra.branch} web=${extra.web} docTok=${extra.docTokens} ` +
      `in=${r.usage.inputTokens} cached=${r.usage.cachedInputTokens} out=${r.usage.outputTokens} ` +
      `reason=${r.usage.reasoningTokens} ttft=${r.ttftMs}ms total=${r.totalMs}ms ` +
      `cost=$${usd.toFixed(4)} today(user)=$${total.toFixed(3)}`,
  );
}

export function docTokenCount(pages: DocumentTextRow[]): number {
  return approxTokens(pages.map((p) => p.text).join(""));
}
