import { aiJson } from "@/lib/ai";
import { env } from "@/lib/env";
import type { DocumentAiMeta } from "@/lib/types";

/**
 * The reception AI: a cheap classifier that writes a complete ROUTING TICKET
 * for every free-text question — which tier answers and exactly what context
 * it receives. It never answers questions itself. Quality-first calibration:
 * when unsure it must route UP, and the visible floor is the passage tier.
 */

export type Tier = "lookup" | "passage" | "document" | "research";

export interface RoutingTicket {
  tier: Tier;
  /** Chars of document text around the highlight to include. */
  surrounding: 0 | 600 | 2000;
  conversation: "none" | "last2" | "summary" | "full";
  /** Include the document's hierarchical summary. */
  use_summary: boolean;
  /** How many retrieval chunks to fetch (0 = no RAG). */
  rag_chunks: number;
  /** Allow the model to search the web. */
  web: boolean;
  answer_length: "short" | "medium" | "long";
  /** "plain" = novice-level everyday language, analogies, no jargon echoed back. */
  register: "standard" | "plain";
}

/** Safe default when the dispatcher fails: today's behaviour, on the workhorse.
 * use_summary=true: the document map costs ~600 cheap input tokens and measurably
 * deepens passage explanations on dense material (blind-eval finding). */
export const FALLBACK_TICKET: RoutingTicket = {
  tier: "passage",
  surrounding: 600,
  conversation: "last2",
  use_summary: true,
  rag_chunks: 0,
  web: false,
  answer_length: "medium",
  register: "standard",
};

/** The quick-action buttons carry known intent — no classification needed. */
export const BUTTON_TICKETS: Record<string, RoutingTicket> = {
  explain_simpler: { ...FALLBACK_TICKET, register: "plain" },
  give_example: { ...FALLBACK_TICKET },
};

const TICKET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tier", "surrounding", "conversation", "use_summary", "rag_chunks", "web", "answer_length", "register"],
  properties: {
    tier: { type: "string", enum: ["lookup", "passage", "document", "research"] },
    surrounding: { type: "integer", enum: [0, 600, 2000] },
    conversation: { type: "string", enum: ["none", "last2", "summary", "full"] },
    use_summary: { type: "boolean" },
    rag_chunks: { type: "integer", minimum: 0, maximum: 8 },
    web: { type: "boolean" },
    answer_length: { type: "string", enum: ["short", "medium", "long"] },
    register: { type: "string", enum: ["standard", "plain"] },
  },
} as const;

const DISPATCH_SYSTEM = `You are the routing dispatcher of a deep-reading app. The reader highlighted a passage in a document and asked a question about it. You NEVER answer — you output a routing ticket deciding which answer tier runs and exactly what context it gets.

Tiers:
- "lookup": ONLY mechanical asks with zero interpretation: a synonym, a word translation, a dictionary definition of a common term. surrounding=0, no rag, short answer.
- "passage": explain/clarify/discuss the highlighted passage. The default for anything interpretive. surrounding=600 (or 2000 if the question references nearby content). Set use_summary=true — the document map is cheap and grounds the explanation.
- "document": the question needs other parts of the document (comparisons across sections, "how does this relate to…", plot/argument questions). Set rag_chunks 4-6, use_summary=true, surrounding=600.
- "research": multi-step analytical work on a dense document (verify a conclusion against methods/tables, critique, cross-check claims). rag_chunks 6-8, use_summary=true, surrounding=2000.

Context rules:
- conversation: "none" for standalone questions, "last2" when it references the immediately previous exchange, "summary" when the thread is long (history_count >= 6) and the question continues it, "full" only for short threads the question explicitly builds on.
- web=true whenever ANY PART of the answer needs information that cannot be inside the document itself: author background, historical context, current events, reception/replication/criticism of the work, anything that happened after the document was written. This is independent of tier — a research-tier question about external validation still needs web=true. Never for things the document itself answers.

- Any question about the document AS A WHOLE — its main conclusion, overall argument, structure, "what does the article claim/show" — is tier "document" MINIMUM, with rag_chunks >= 4 and use_summary=true, even when phrased casually.
- answer_length: "short" only for lookups and single-fact answers; interpretive explanations default to "medium".
- register: decided by the CURRENT question ALONE. "plain" ONLY when this question itself asks for simple language — "explain simply", "I have no idea about this", "like I'm a beginner / no high school", "in real-life terms". Everything else is "standard" (professional tone), EVEN IF earlier messages in the thread asked for simple explanations. A reader who asked for simple once has not asked for baby-talk forever.
- FAILED-UNDERSTANDING LOOP: if the recent messages show the reader ALREADY asked for a simpler explanation and is asking again (says they did not understand, wants it even simpler, sounds frustrated), this is an escalation signal: raise the tier by one (passage -> document), set register="plain", and keep answer_length "short" or "medium". A reader asking twice means the previous tier failed — never answer the third ask with the same tier.

Examples:
- "was this study ever replicated?" -> tier=research, web=true (replication happened outside the document)
- "who is the author and what else did they write?" -> web=true
- "who are these people / are they legit / is this author credible?" -> web=true, register=standard (credibility lives outside the document; this is a factual professional question, not a request for simple language)
- "what does this term mean?" -> web=false (the document/general knowledge answers it)
- "what is the main conclusion of the article and what supports it?" -> tier=document, rag_chunks=5, use_summary=true, answer_length=medium
- "explain this passage more simply" -> tier=passage, surrounding=600, answer_length=medium
- answer_length: short for lookups and yes/no, medium default, long for "explain in depth / walk me through".

CALIBRATION, most important rule: when unsure between two tiers, ALWAYS pick the higher one. A wasted cent is nothing; a shallow answer costs the reader's trust. Ambiguous or vague questions are NEVER "lookup".`;

export interface DispatchInput {
  question: string;
  quote: string;
  docTitle: string;
  meta: DocumentAiMeta | null;
  historyCount: number;
  isRegion: boolean;
  /** The reader's most recent messages (oldest first) — dissatisfaction signal. */
  recentUserMessages?: string[];
}

export async function dispatch(input: DispatchInput): Promise<{
  ticket: RoutingTicket;
  fallback: boolean;
}> {
  const metaLine = input.meta
    ? `Document type: ${input.meta.doc_type}, language: ${input.meta.language}, domain: ${input.meta.domain}.`
    : "Document type: unknown.";
  const prompt = [
    `Document: "${input.docTitle}". ${metaLine}`,
    input.isRegion
      ? "The anchor is a captured image region (chart/table/figure)."
      : `Highlighted passage (may be truncated): "${input.quote.slice(0, 400)}"`,
    `Messages already in this thread: ${input.historyCount}`,
    input.recentUserMessages && input.recentUserMessages.length > 0
      ? `Reader's previous messages (oldest first):\n${input.recentUserMessages
          .map((m) => `- "${m.slice(0, 160)}"`)
          .join("\n")}`
      : "",
    "",
    `Reader's question: "${input.question}"`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  try {
    const { value } = await aiJson<RoutingTicket>({
      model: env.modelDispatcher,
      system: DISPATCH_SYSTEM,
      input: prompt,
      effort: "minimal",
      maxOutputTokens: 1200,
      schemaName: "routing_ticket",
      schema: TICKET_SCHEMA as unknown as Record<string, unknown>,
    });
    // Belt and braces: clamp values the schema already constrains.
    value.rag_chunks = Math.max(0, Math.min(8, value.rag_chunks));
    applyCascadeGuard(value, input);
    return { ticket: value, fallback: false };
  } catch (err) {
    console.error("dispatcher failed, using fallback ticket:", err);
    const ticket = { ...FALLBACK_TICKET };
    applyCascadeGuard(ticket, input);
    return { ticket, fallback: true };
  }
}

/** Signals that the reader is asking for a simpler explanation. */
const SIMPLIFY =
  /simpl|understand nothing|understood nothing|no idea|no high ?sch|like i'?m|eli5|real life|nu (am )?[îi]n[țt]eles|n-?am [îi]n[țt]eles|nimic|mai simplu|pe [îi]n[țt]elesul/i;

/** Questions whose answer must come from outside the document. */
const NEEDS_WEB =
  /legit|credib|reputat|cine (e|este|sunt) (autor|acest|ace[sș]t)|who (is|are) (the )?author|are they (real|legit)|is (he|she|this author)/i;

/**
 * Deterministic guards: promised behaviour never left to the classifier.
 *  - plain register comes ONLY from the CURRENT question (never sticky).
 *  - a repeated simplify-ask escalates the tier (failed-understanding cascade).
 *  - author/credibility questions always get the web tool.
 */
function applyCascadeGuard(ticket: RoutingTicket, input: DispatchInput): void {
  if (NEEDS_WEB.test(input.question)) ticket.web = true;

  // Document-level tiers always retrieve — a whole-document answer without
  // excerpts is guesswork (classifier occasionally omits it).
  if (ticket.tier === "document" && ticket.rag_chunks < 4) ticket.rag_chunks = 4;
  if (ticket.tier === "research" && ticket.rag_chunks < 6) ticket.rag_chunks = 6;
  if (ticket.tier === "document" || ticket.tier === "research") ticket.use_summary = true;

  if (!SIMPLIFY.test(input.question)) {
    // The reader did not ask for simple language THIS time — professional tone,
    // even if earlier messages in the thread did.
    ticket.register = "standard";
    return;
  }
  ticket.register = "plain";
  const priorAsks = (input.recentUserMessages ?? []).filter((m) => SIMPLIFY.test(m)).length;
  if (priorAsks >= 1 && (ticket.tier === "lookup" || ticket.tier === "passage")) {
    ticket.tier = "document";
  }
}
