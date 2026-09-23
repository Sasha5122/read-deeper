import { z } from "zod";
import { NextResponse } from "next/server";
import { ApiError, handleErrors } from "@/lib/api";
import { buildOffsets, extractDocument, fullTextOf, locateElements } from "@/lib/extract";
import { CONVERTIBLE_KINDS, convertToPdf } from "@/lib/convert";
import { env } from "@/lib/env";
import { requireUser } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const maxDuration = 300;

/**
 * Retry the office→PDF conversion for a document whose original upload fell
 * back to reflow extraction (pdf_path is null because Gotenberg was down).
 * Re-downloads the original, converts it, re-extracts the text layer from the
 * converted PDF and sets pdf_path so the reader shows original pages.
 *
 * CAVEAT: the text layer is rebuilt, so global char offsets change. Existing
 * highlights re-anchor on next open via their quote/prefix/suffix fallback
 * (lib/anchoring.ts) — exact-offset anchors are intentionally sacrificed for
 * the original-page view. The AI layer (chunks/summary) is rebuilt too.
 */
export const POST = handleErrors(
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
      throw new ApiError(403, "Only your own uploaded documents can be reconverted.");
    }
    if (!CONVERTIBLE_KINDS.has(document.kind)) {
      throw new ApiError(400, "This document type does not use PDF conversion.");
    }
    if (document.pdf_path) throw new ApiError(400, "This document already has original pages.");
    if (!document.file_path) throw new ApiError(400, "The original file is no longer available.");

    const admin = createSupabaseAdmin();

    // MUTUAL EXCLUSION (review finding): two concurrent reconverts would
    // interleave the delete/insert of document_text and corrupt the offsets
    // invariant. The conditional status flip is the lock — only ONE request
    // wins the ready->processing transition; everyone else gets a 409.
    const { count: lockCount } = await admin
      .from("documents")
      .update({ status: "processing" }, { count: "exact" })
      .eq("id", document.id)
      .eq("status", "ready");
    if (!lockCount) throw new ApiError(409, "This document is already being reconverted.");
    // Once the old text layer's delete begins, a failure can no longer restore
    // the previous state — the doc is then marked "failed" (visible, deletable)
    // instead of being left silently corrupted. Before that point, any failure
    // releases the lock back to "ready" (old reflow layer untouched).
    let textReplacementStarted = false;
    const releaseLock = async (to: "ready" | "failed") => {
      await admin.from("documents").update({ status: to }).eq("id", document.id);
    };

    let pdfPath: string;
    try {
      const { data: blob, error: dlErr } = await admin.storage
        .from("uploads")
        .download(document.file_path);
      if (dlErr || !blob) throw new ApiError(502, "Could not download the original file.");

      let pdfBuffer: Buffer;
      try {
        pdfBuffer = await convertToPdf(
          Buffer.from(await blob.arrayBuffer()),
          document.file_path.split("/").pop() ?? "file",
        );
      } catch (convErr) {
        console.error(`[reconvert] ${document.id}: conversion failed —`, convErr);
        throw new ApiError(502, "PDF conversion is still unavailable — try again later.");
      }

      pdfPath = `${document.file_path}.pdf`;
      const { error: pdfErr } = await admin.storage
        .from("uploads")
        .upload(pdfPath, pdfBuffer, { contentType: "application/pdf", upsert: true });
      if (pdfErr) throw new ApiError(500, pdfErr.message);

      // Extract FIRST, replace rows only once extraction has succeeded — a
      // failed re-extraction must leave the existing reflow text layer intact.
      const { pages, elements } = await extractDocument(pdfBuffer, "pdf");
      if (pages.length === 0) {
        throw new ApiError(422, "No pages could be extracted from the converted PDF.");
      }

      const rows = buildOffsets(document.id, pages);
      textReplacementStarted = true;
      const { error: delTextErr } = await admin
        .from("document_text")
        .delete()
        .eq("document_id", document.id);
      if (delTextErr) throw new ApiError(500, delTextErr.message);
      for (let i = 0; i < rows.length; i += 500) {
        const { error: insErr } = await admin.from("document_text").insert(rows.slice(i, i + 500));
        if (insErr) throw new ApiError(500, insErr.message);
      }
      // Non-text elements: old rows carry offsets into the OLD text — replace them.
      await admin.from("document_elements").delete().eq("document_id", document.id);
      const located = locateElements(fullTextOf(rows), elements);
      if (located.length > 0) {
        const elementRows = [];
        for (const el of located) {
          let storagePath: string | null = null;
          if (el.kind === "image" && el.buffer) {
            const ext = el.mime?.includes("svg") ? "svg" : el.mime?.includes("jpeg") ? "jpg" : "png";
            storagePath = `${document.id}/${el.kind}-${el.element_no}.${ext}`;
            const { error: imgErr } = await admin.storage
              .from("elements")
              .upload(storagePath, el.buffer, { contentType: el.mime ?? "image/png", upsert: true });
            if (imgErr) storagePath = null; // element survives without its bytes
          }
          elementRows.push({
            document_id: document.id,
            kind: el.kind,
            element_no: el.element_no,
            char_start: el.char_start,
            char_end: el.char_end,
            storage_path: storagePath,
            content_text: el.content_text ?? null,
            caption: null,
          });
        }
        for (let i = 0; i < elementRows.length; i += 200) {
          const { error: elErr } = await admin
            .from("document_elements")
            .insert(elementRows.slice(i, i + 200));
          if (elErr) throw new ApiError(500, elErr.message);
        }
      }

      const { error: updErr } = await admin
        .from("documents")
        .update({ pdf_path: pdfPath, status: "ready" })
        .eq("id", document.id);
      if (updErr) throw new ApiError(500, updErr.message);

      // Offsets changed — rebuild the AI layer (chunks, markdown, summary).
      if (env.hasOpenAI) {
        const { prepareDocumentAi } = await import("@/lib/aiprep");
        void prepareDocumentAi(document.id);
      }

      return NextResponse.json({ ...document, pdf_path: pdfPath, status: "ready" });
    } catch (err) {
      await releaseLock(textReplacementStarted ? "failed" : "ready");
      throw err;
    }
  },
);
