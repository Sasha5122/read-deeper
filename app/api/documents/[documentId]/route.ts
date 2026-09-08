import { z } from "zod";
import { NextResponse } from "next/server";
import { ApiError, handleErrors } from "@/lib/api";
import { requireUser } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * Delete a whole session: the uploaded document and, via DB cascades, its
 * text layer, highlights, regions, threads and messages. Library documents
 * cannot be deleted — only the user's own uploads.
 */
export const DELETE = handleErrors(
  async (_request: Request, ctx: { params: Promise<{ documentId: string }> }) => {
    const { supabase, user } = await requireUser();
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(await ctx.params);

    const { data: document } = await supabase
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .maybeSingle();
    if (!document) throw new ApiError(404, "Document not found");
    if (document.owner_id !== user.id) {
      throw new ApiError(403, "Only your own uploaded documents can be deleted.");
    }

    // RLS-enforced delete; child rows fall with it (on delete cascade).
    const { error: delErr } = await supabase.from("documents").delete().eq("id", documentId);
    if (delErr) throw new ApiError(500, delErr.message);

    // Best-effort storage cleanup — a leftover blob must never block the delete.
    const admin = createSupabaseAdmin();
    try {
      const uploadPaths = [document.file_path, document.pdf_path].filter(
        (p): p is string => !!p,
      );
      if (uploadPaths.length > 0) await admin.storage.from("uploads").remove(uploadPaths);
      for (const folder of [documentId, `captures/${documentId}`]) {
        const { data: files } = await admin.storage.from("elements").list(folder);
        if (files && files.length > 0) {
          await admin.storage
            .from("elements")
            .remove(files.map((f) => `${folder}/${f.name}`));
        }
      }
    } catch (err) {
      console.error("storage cleanup after document delete failed", err);
    }

    return NextResponse.json({ ok: true });
  },
);
