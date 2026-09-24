import { z } from "zod";
import type OpenAI from "openai";
import { handleErrors } from "@/lib/api";
import { aiJson, aiStreamText } from "@/lib/ai";
import { ANSWER_SYSTEM, answerHeader, docTokenCount, documentBlock } from "@/lib/answer";
import { retrieveChunksMulti } from "@/lib/rag";
import { getDocumentWithPages } from "@/lib/docs";
import { env } from "@/lib/env";
import { requireUser } from "@/lib/supabase/server";
import type { DocumentTextRow } from "@/lib/types";

export const maxDuration = 120;

const AskDocument = z.object({
  documentId: z.string().uuid(),
  question: z.string().trim().min(1).max(4000),
});

const TOP_K = 6;

/** How many chunks each reformulated query retrieves, and the union cap. */
const CHUNKS_PER_QUERY = 8;
const CHUNKS_UNION_CAP = 32;

/**
 * The exhaustive-scan task, appended AFTER the cached document prefix (full
 * branch) or as the question message (oversized branch). Search must be
 * trustworthy as COVERAGE: every relevant place, not the single best match.
 * The verbatim «quote» (p. N) tail on every finding is load-bearing: the
 * client turns each finding into a clickable row and the reader locates the
 * exact zone on the page by searching for that quote — paraphrases break it.
 */
const SEARCH_TASK = `This is a search over the whole document, not a normal question. List EVERY place in the document relevant to the question, one finding per bullet. EVERY listed finding MUST end with a short VERBATIM quote from the document in guillemets plus the page, exactly like: «exact words from the document» (p. N). The quote must be 3-12 words copied verbatim from the document (it is used to locate the spot) — never paraphrase inside the guillemets. Never group several findings into one bullet: each finding gets its own bullet with its own quote and page. Be complete: cover the entire document, not just the best match. Do not stop at the first matches — scan to the END of the document; findings from late pages are as important as early ones. Answer in the user's language.`;

/**
 * "Find by meaning" over the whole document, streamed with (p. N) citations.
 *
 * Full-context branch (docTokenCount <= DOC_FULL_CONTEXT_MAX_TOKENS): rides
 * the SAME provider prompt cache as answers/warm — instructions =
 * ANSWER_SYSTEM and first user message = documentBlock(...) are byte-identical
 * with warmDocumentCache's request (same answerHeader, same status==="ready"
 * markdown gate), prompt_cache_key = documentId, reasoning effort =
 * env.reasoningEffortAnswer (the warmed "medium" lane), no text.verbosity
 * (the warmed default lane). The search task is appended as SUBSEQUENT
 * messages so it never touches the cached prefix.
 *
 * Oversized branch: multi-query retrieval (3 cheap reformulations + the
 * original, union-deduped) + the FULL summary_md map, with an explicit
 * instruction that findings may come from the map even without an excerpt.
 */
export const POST = handleErrors(async (request: Request) => {
  const { supabase } = await requireUser();
  const body = AskDocument.parse(await request.json());

  if (!env.hasOpenAI) {
    return Response.json(
      { error: "AI is not connected yet — add OPENAI_API_KEY to .env.local and restart." },
      { status: 503 },
    );
  }

  const { document, pages } = await getDocumentWithPages(supabase, body.documentId);
  const { data: docAi } = await supabase
    .from("document_ai")
    .select("*")
    .eq("document_id", body.documentId)
    .maybeSingle();

  const full = docTokenCount(pages) <= env.docFullContextMaxTokens;

  let system: string;
  let input: string | OpenAI.Responses.ResponseInput;
  let cacheKey: string | undefined;
  let effort: "minimal" | "low" | "medium" | "high" = "medium";

  if (full) {
    // Cached-prefix branch. Markdown gated on status==="ready" EXACTLY like
    // the warm route and the messages route — any asymmetry breaks the prefix.
    const meta = docAi?.status === "ready" ? docAi.summary_meta : null;
    const docBlock = documentBlock(
      pages,
      docAi?.status === "ready" ? docAi.markdown : null,
      answerHeader(document, meta),
    );
    system = ANSWER_SYSTEM;
    input = [
      { role: "user", content: docBlock },
      { role: "assistant", content: "Understood — I have the document. What should I find?" },
      { role: "user", content: `${SEARCH_TASK}\n\nQuestion: ${body.question}` },
    ];
    cacheKey = body.documentId;
    effort = env.reasoningEffortAnswer;
  } else {
    const queries = await searchQueries(body.question, document.title);
    const chunks = await retrieveChunksMulti(
      body.documentId,
      queries,
      CHUNKS_PER_QUERY,
      CHUNKS_UNION_CAP,
    );
    const excerpts =
      chunks.length > 0
        ? chunks.map(
            (c) =>
              `<excerpt pages="${c.page_from}-${c.page_to}"${c.heading ? ` section="${c.heading}"` : ""}>\n${c.text}\n</excerpt>`,
          )
        : rankPages(pages, body.question)
            .slice(0, TOP_K)
            .map((p) => `<excerpt pages="${p.page_no}-${p.page_no}">\n${p.text}\n</excerpt>`);

    system = [
      "You are a patient expert helping the user search a document they are reading.",
      "Answer from the material below; cite page numbers like (p. 12).",
      "If the document does not contain anything relevant, say so plainly.",
      "Answer in the language the user asked in.",
      "",
      answerHeader(document, docAi?.status === "ready" ? docAi.summary_meta : null),
      docAi?.summary_md ? `\nDocument map:\n${docAi.summary_md}` : "",
      "\nRelevant excerpts:",
      ...excerpts,
      docAi?.summary_md
        ? '\nThe document map above covers ALL sections. Check every section of the map for relevance, not only the excerpts. If the excerpts don\'t cover a section the map suggests is relevant, still report that section with its pages. After listing the findings, you MUST add a final line exactly of the form "Coverage: checked all N sections of the document map." where N is the real number of sections in the map — walk the map section by section to produce it.'
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    input = `${SEARCH_TASK}\n\nQuestion: ${body.question}`;
  }

  // Abort plumbing (mirrors the messages route): closing the dialog aborts
  // the client fetch — request.signal and the stream's cancel() both stop the
  // OpenAI generation (and its billing) instead of letting it run to the end.
  const upstream = new AbortController();
  if (request.signal.aborted) upstream.abort();
  else request.signal.addEventListener("abort", () => upstream.abort(), { once: true });

  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await aiStreamText(
          {
            model: env.modelAnswer,
            system,
            input,
            effort,
            maxOutputTokens: 6000,
            ...(cacheKey ? { cacheKey } : {}),
          },
          (delta) => {
            try {
              controller.enqueue(encoder.encode(delta));
            } catch {
              // response cancelled — deltas after that point are dropped
            }
          },
          upstream.signal,
        );
        try {
          controller.close();
        } catch { /* already cancelled */ }
      } catch (err) {
        if (upstream.signal.aborted) return; // clean client abort — not an error
        console.error("document ask failed", err);
        controller.error(err);
      }
    },
    cancel() {
      upstream.abort();
    },
  });

  return new Response(readable, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
});

const QUERIES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["queries"],
  properties: {
    queries: {
      type: "array",
      items: { type: "string" },
      description:
        "Three alternative phrasings of the search, in the search's own language: one with synonyms, one using the document's likely terminology, one broader/more abstract.",
    },
  },
} as const;

/**
 * Multi-query expansion for oversized docs: one cheap utility call, hard-capped
 * at 2s — on timeout or failure the search simply runs on the original query.
 */
async function searchQueries(question: string, docTitle: string): Promise<string[]> {
  const call = aiJson<{ queries: string[] }>({
    model: env.modelUtility,
    system:
      "You expand a reader's search over a document into alternative phrasings so embedding retrieval catches every relevant section. Return exactly 3 reformulations in the same language as the search: one with synonyms, one using the document's likely terminology, one broader/more abstract.",
    input: `Document: "${docTitle}"\nSearch: "${question.slice(0, 400)}"`,
    effort: "minimal",
    maxOutputTokens: 700,
    schemaName: "search_queries",
    schema: QUERIES_SCHEMA as unknown as Record<string, unknown>,
  }).then((r) =>
    r.value.queries.map((q) => q.trim()).filter((q) => q.length > 0).slice(0, 3),
  );
  const timeout = new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 2000));
  const extra = await Promise.race([call, timeout]).catch(() => [] as string[]);
  return [question, ...extra];
}

/** Score pages by query-term frequency, weighted by inverse page frequency. */
export function rankPages(pages: DocumentTextRow[], question: string): DocumentTextRow[] {
  const terms = Array.from(
    new Set(
      question
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 2),
    ),
  );
  if (terms.length === 0) return pages.slice();

  const docFreq = new Map<string, number>();
  const lowered = pages.map((p) => p.text.toLowerCase());
  for (const term of terms) {
    docFreq.set(term, lowered.filter((t) => t.includes(term)).length);
  }

  const scored = pages.map((page, i) => {
    let score = 0;
    for (const term of terms) {
      const df = docFreq.get(term) ?? 0;
      if (df === 0) continue;
      const count = lowered[i].split(term).length - 1;
      score += count * Math.log(1 + pages.length / df);
    }
    return { page, score };
  });
  return scored.sort((a, b) => b.score - a.score).map((s) => s.page);
}
