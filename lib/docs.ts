import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "@/lib/api";
import { fullTextOf } from "@/lib/extract";
import type { Database, DocumentRow, DocumentTextRow } from "@/lib/types";

export type Db = SupabaseClient<Database>;

/** Load a readable document plus its ordered text layer (RLS enforces access). */
export async function getDocumentWithPages(
  supabase: Db,
  documentId: string,
): Promise<{ document: DocumentRow; pages: DocumentTextRow[]; fullText: string }> {
  const { data: document, error } = await supabase
    .from("documents")
    .select("*")
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw new ApiError(500, error.message);
  if (!document) throw new ApiError(404, "Document not found");
  if (document.status !== "ready") throw new ApiError(409, `Document is ${document.status}`);

  const { data: pages, error: pagesError } = await supabase
    .from("document_text")
    .select("*")
    .eq("document_id", documentId)
    .order("page_no", { ascending: true });
  if (pagesError) throw new ApiError(500, pagesError.message);

  const pageRows = pages ?? [];
  return { document, pages: pageRows, fullText: fullTextOf(pageRows) };
}
