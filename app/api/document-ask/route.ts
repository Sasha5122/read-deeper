import { z } from "zod";
import { handleErrors } from "@/lib/api";
import { aiStreamText } from "@/lib/ai";
import { retrieveChunks } from "@/lib/executor";
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

/**
 * "Ask about the whole document": semantic retrieval (pgvector embeddings)
 * over the AI chunks, lexical page ranking as fallback, then a streamed
 * answer from the strong model with page citations.
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

  // Semantic first; lexical page ranking if the AI layer is not ready yet.
  const chunks = await retrieveChunks(body.documentId, body.question, TOP_K);
  const excerpts =
    chunks.length > 0
      ? chunks.map(
          (c) =>
            `<excerpt pages="${c.page_from}-${c.page_to}"${c.heading ? ` section="${c.heading}"` : ""}>\n${c.text}\n</excerpt>`,
        )
      : rankPages(pages, body.question)
          .slice(0, TOP_K)
          .map((p) => `<excerpt pages="${p.page_no}-${p.page_no}">\n${p.text}\n</excerpt>`);

  const { data: docAi } = await supabase
    .from("document_ai")
    .select("summary_md")
    .eq("document_id", body.documentId)
    .maybeSingle();

  const system = [
    "You are a patient expert helping the user understand a document.",
    "Answer using the provided excerpts; cite page numbers like (p. 12).",
    "If the excerpts do not contain the answer, say so plainly.",
    "Answer in the language the user asked in.",
    "",
    `Document: ${document.title}${document.author ? ` — ${document.author}` : ""}`,
    docAi?.summary_md ? `\nDocument map (orientation only):\n${docAi.summary_md}` : "",
    "",
    ...excerpts,
  ].join("\n");

  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await aiStreamText(
          {
            model: env.modelDocument,
            system,
            input: body.question,
            effort: "medium",
            maxOutputTokens: 6000,
          },
          (delta) => controller.enqueue(encoder.encode(delta)),
        );
        controller.close();
      } catch (err) {
        console.error("document ask failed", err);
        controller.error(err);
      }
    },
  });

  return new Response(readable, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
});

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
