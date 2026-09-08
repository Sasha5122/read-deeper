import type OpenAI from "openai";
import { aiStreamText, type AiUsage, type Effort } from "@/lib/ai";
import { env } from "@/lib/env";
import { trimHistory } from "@/lib/context";
import { retrieveChunks, type RagChunk } from "@/lib/rag";
import type { RoutingTicket, Tier } from "@/lib/dispatcher";
import type { DocumentAiMeta, Role } from "@/lib/types";

export { retrieveChunks, type RagChunk };

/**
 * The executor takes a routing ticket and assembles EXACTLY the context it
 * prescribes — quote, dosed surroundings, dosed history, RAG chunks, document
 * summary, optional web search, optional image — then streams the answer from
 * the tier's model. Not a token more than the ticket asked for.
 */

export function modelForTier(tier: Tier): string {
  if (tier === "lookup") return env.modelLookup;
  if (tier === "passage") return env.modelThread;
  return env.modelDocument;
}

const EFFORT_BY_TIER: Record<Tier, Effort> = {
  lookup: "minimal",
  passage: "low",
  document: "medium",
  research: "high",
};

// Caps include reasoning tokens (Responses API), so they carry headroom.
const MAX_TOKENS_BY_LENGTH = { short: 2000, medium: 6000, long: 10000 } as const;

export interface ExecutorInput {
  ticket: RoutingTicket;
  question: string;
  quote: string;
  before: string; // already sliced to ticket.surrounding by the caller
  after: string;
  pageNo: number;
  docTitle: string;
  docAuthor: string | null;
  meta: DocumentAiMeta | null;
  summaryMd: string | null;
  threadSummary: string | null;
  history: { role: Role; content: string }[];
  ragChunks: RagChunk[];
  /** PNG data URL of a captured region, for vision. */
  imageDataUrl?: string | null;
}

/**
 * System prompt structure is deliberately stable per thread (persona + doc +
 * passage + summary), so OpenAI prompt caching hits across a conversation.
 */
export function buildPrompt(input: ExecutorInput): {
  system: string;
  messages: { role: Role; content: string }[];
} {
  const { ticket } = input;
  const parts: string[] = [
    "You are a careful, warm reading companion sitting in the margin of a document, answering about the exact passage the reader highlighted.",
    "Stay faithful to the passage and the provided excerpts. If something is not in the material, say so rather than inventing it.",
    "Answer in the language the reader asked in. No filler, no restating the question.",
  ];
  if (ticket.register === "plain") {
    parts.push(
      "",
      "PLAIN MODE — the reader is a complete beginner on this subject:",
      "- Use ONLY everyday words. Never echo the document's technical terms back; translate each idea into normal life language. If one technical word is unavoidable, explain it in brackets with words a child knows.",
      "- Lead with ONE concrete real-life analogy or scenario that carries the whole idea, then 2-3 short plain sentences of what the passage actually says.",
      "- Short sentences. No page citations, no bullet lists of jargon, no academic tone.",
      "- If the reader says they still do not understand, do NOT repeat the same explanation slower — change the analogy entirely and cut the detail in half.",
    );
  } else {
    parts.push(
      "Write like a knowledgeable professional — the register of a top-tier AI assistant: direct, precise, well-organized prose. Cite pages like (p. 4) when you draw on the excerpts or the wider document; never cite a page number you were not shown.",
      "Do NOT use childlike analogies, invented scenarios or 'imagine that...' framings unless the reader explicitly asks for a simple explanation.",
      "Light Markdown renders in the card: **bold** for the few load-bearing terms, short - lists when they genuinely help. A short answer is one tight paragraph — no list, no heading. Never open with a heading.",
    );
  }
  parts.push("", `Document: ${input.docTitle}${input.docAuthor ? ` — ${input.docAuthor}` : ""}`);
  if (input.meta) {
    parts.push(
      `Type: ${input.meta.doc_type} · Domain: ${input.meta.domain} · Language: ${input.meta.language}`,
    );
  }
  if (input.imageDataUrl) {
    parts.push(
      "",
      `The reader captured an image region on page ${input.pageNo} (attached) — a chart, table, figure or formula. Describe/interpret what is actually visible in it.`,
    );
  } else {
    parts.push("", `Highlighted passage (page ${input.pageNo}):`, `<passage>${input.quote}</passage>`);
  }
  if (ticket.surrounding > 0 && (input.before || input.after)) {
    parts.push(
      "",
      "Surrounding text:",
      `<before>${input.before}</before>`,
      `<after>${input.after}</after>`,
    );
  }
  if (ticket.use_summary && input.summaryMd) {
    parts.push("", "Document map (orientation only — cite passages, not this map):", input.summaryMd);
  }
  if (input.ragChunks.length > 0) {
    parts.push("", "Relevant excerpts from elsewhere in the document:");
    for (const c of input.ragChunks) {
      parts.push(
        `<excerpt pages="${c.page_from}-${c.page_to}"${c.heading ? ` section="${c.heading}"` : ""}>\n${c.text}\n</excerpt>`,
      );
    }
  }
  if (ticket.web) {
    parts.push(
      "",
      "This question needs information from OUTSIDE the document (people, credibility, context, later events). USE the web search tool — do not answer from the document alone or tell the reader to look it up themselves. Bring back concrete facts: names, affiliations, positions, notable work, dates. Clearly separate document facts from web facts, and cite web sources as short markdown links ([site](url)) without tracking parameters.",
    );
  }

  // History, dosed per ticket.
  let history: { role: Role; content: string }[] = [];
  if (ticket.conversation === "last2") history = input.history.slice(-4);
  else if (ticket.conversation === "full") history = trimHistory(input.history, 4000);
  else if (ticket.conversation === "summary" && input.threadSummary) {
    parts.push("", "Conversation so far (summary):", input.threadSummary);
    history = input.history.slice(-2);
  }

  return {
    system: parts.join("\n"),
    messages: [...history, { role: "user", content: input.question }],
  };
}

/** Stream the answer per ticket. onDelta receives text chunks. */
export async function executeTicket(
  input: ExecutorInput,
  onDelta: (text: string) => void,
): Promise<{ text: string; usage: AiUsage; model: string }> {
  const { system, messages } = buildPrompt(input);
  let model = modelForTier(input.ticket.tier);
  let effort = EFFORT_BY_TIER[input.ticket.tier];
  if (input.ticket.web) {
    // web_search is rejected at effort "minimal", and a web-grounded synthesis
    // is user-visible work — floor it at the workhorse tier with real effort.
    if (input.ticket.tier === "lookup") model = env.modelThread;
    if (effort === "minimal") effort = "low";
  }

  let apiInput: string | OpenAI.Responses.ResponseInput;
  if (input.imageDataUrl) {
    const prior = messages.slice(0, -1);
    apiInput = [
      ...prior.map((m) => ({ role: m.role, content: m.content })),
      {
        role: "user" as const,
        content: [
          { type: "input_text" as const, text: input.question },
          { type: "input_image" as const, image_url: input.imageDataUrl, detail: "auto" as const },
        ],
      },
    ];
  } else {
    apiInput = messages.map((m) => ({ role: m.role, content: m.content }));
  }

  const { text, usage } = await aiStreamText(
    {
      model,
      system,
      input: apiInput,
      effort,
      maxOutputTokens: MAX_TOKENS_BY_LENGTH[input.ticket.answer_length],
      webSearch: input.ticket.web,
    },
    onDelta,
  );
  return { text, usage, model };
}
