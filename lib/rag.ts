import { aiEmbed } from "@/lib/ai";
import { vectorLiteral } from "@/lib/aiprep";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

/** Semantic retrieval over a document's chunks (pgvector). */

export interface RagChunk {
  id: string;
  idx: number;
  text: string;
  heading: string | null;
  page_from: number;
  page_to: number;
  similarity: number;
}

export async function retrieveChunks(
  documentId: string,
  question: string,
  k: number,
): Promise<RagChunk[]> {
  if (k <= 0) return [];
  try {
    const [embedding] = await aiEmbed([question]);
    const admin = createSupabaseAdmin();
    const { data, error } = await admin.rpc("match_chunks", {
      p_document_id: documentId,
      p_query: vectorLiteral(embedding),
      p_limit: k,
    });
    if (error) throw new Error(error.message);
    return data ?? [];
  } catch (err) {
    console.error("RAG retrieval failed (answering without it):", err);
    return [];
  }
}

/**
 * Multi-query retrieval (search coverage): run every reformulation of the
 * query in parallel, union the results by chunk id (keeping each chunk's best
 * similarity), cap the union, and return the survivors in DOCUMENT ORDER so
 * the model reads them as a sweep across the document, not a relevance pile.
 */
export async function retrieveChunksMulti(
  documentId: string,
  queries: string[],
  perQuery: number,
  cap: number,
): Promise<RagChunk[]> {
  const lists = await Promise.all(queries.map((q) => retrieveChunks(documentId, q, perQuery)));
  const byId = new Map<string, RagChunk>();
  for (const list of lists) {
    for (const chunk of list) {
      const prev = byId.get(chunk.id);
      if (!prev || chunk.similarity > prev.similarity) byId.set(chunk.id, chunk);
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, cap)
    .sort((a, b) => a.page_from - b.page_from || a.idx - b.idx);
}
