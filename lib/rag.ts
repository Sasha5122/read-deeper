import { aiEmbed } from "@/lib/ai";
import { vectorLiteral } from "@/lib/aiprep";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

/** Semantic retrieval over a document's chunks (pgvector). */

export interface RagChunk {
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
