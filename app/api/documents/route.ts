import { z } from "zod";
import { NextResponse } from "next/server";
import { ApiError, handleErrors } from "@/lib/api";
import { buildOffsets, extractDocument, fullTextOf, locateElements } from "@/lib/extract";
import { CONVERTIBLE_KINDS, convertToPdf } from "@/lib/convert";
import { env } from "@/lib/env";
import { requireUser } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { getPlan } from "@/lib/usage";
import { fileTooLargeMessage, MAX_UPLOAD_BYTES } from "@/lib/upload-limits";

export const maxDuration = 300;

const CreateDocument = z.object({
  title: z.string().trim().min(1).max(300),
  author: z.string().trim().max(300).optional(),
  filePath: z.string().min(1),
  kind: z.enum(["pdf", "docx", "doc", "epub", "mobi", "txt", "rtf", "odt", "html", "pptx", "ppt"]),
});

/**
 * Register an uploaded file (already in Storage) and process it into the
 * text layer. Pro only — enforced server-side.
 */
export const POST = handleErrors(async (request: Request) => {
  const { supabase, user } = await requireUser();
  const body = CreateDocument.parse(await request.json());

  const plan = await getPlan(user.id);
  if (plan !== "pro") throw new ApiError(403, "Uploading your own documents requires Pro.");

  if (!body.filePath.startsWith(`${user.id}/`)) {
    throw new ApiError(400, "filePath must be inside your own folder");
  }

  const { data: document, error: docErr } = await supabase
    .from("documents")
    .insert({
      owner_id: user.id,
      title: body.title,
      author: body.author ?? null,
      source: "upload",
      file_path: body.filePath,
      kind: body.kind,
      status: "processing",
    })
    .select("*")
    .single();
  if (docErr || !document) throw new ApiError(500, docErr?.message ?? "Could not create document");

  // Process synchronously: download, extract page texts, compute global offsets.
  const admin = createSupabaseAdmin();
  // Tracked outside the try so the catch can phrase PDF-specific messages.
  let extractedAsPdf = body.kind === "pdf";
  try {
    const { data: blob, error: dlErr } = await admin.storage
      .from("uploads")
      .download(body.filePath);
    if (dlErr || !blob) throw new Error(dlErr?.message ?? "Download failed");
    if (blob.size > MAX_UPLOAD_BYTES) throw new ApiError(413, fileTooLargeMessage(blob.size));

    let buffer: Buffer = Buffer.from(await blob.arrayBuffer());
    let effectiveKind = body.kind;
    let pdfPath: string | null = body.kind === "pdf" ? body.filePath : null;

    // Office-family formats: convert once to PDF so the reader can show the
    // original pages. Text is then extracted from the SAME pdf, keeping the
    // displayed pages and the text layer page numbers identical.
    if (CONVERTIBLE_KINDS.has(body.kind)) {
      try {
        const pdfBuffer = await convertToPdf(buffer, body.filePath.split("/").pop() ?? "file");
        pdfPath = `${body.filePath}.pdf`;
        const { error: pdfErr } = await admin.storage
          .from("uploads")
          .upload(pdfPath, pdfBuffer, { contentType: "application/pdf", upsert: true });
        if (pdfErr) throw new Error(pdfErr.message);
        buffer = pdfBuffer;
        effectiveKind = "pdf";
        extractedAsPdf = true;
      } catch (convErr) {
        // Converter unavailable: fall back to reflowed text extraction. The
        // document survives without original pages (pdf_path stays null — the
        // client sees the reflow view; POST /api/documents/[id]/reconvert can
        // retry the conversion later).
        console.error(`[convert-fallback] ${document.id} (${body.kind}): pdf conversion skipped —`, convErr);
        pdfPath = null;
      }
    }

    const { pages, elements } = await extractDocument(buffer, effectiveKind);
    if (pages.length === 0) throw new Error("No text could be extracted");

    // Scanned (image-only) PDFs extract with (near-)empty page texts. That is
    // NOT a failure — the original pages still render and captures still work.
    // The reader detects this client-side: avg(page.text.trim().length) < 20.
    if (effectiveKind === "pdf") {
      const avgChars = pages.reduce((n, p) => n + p.text.trim().length, 0) / pages.length;
      if (avgChars < 20) {
        console.log(
          `[scanned-pdf] ${document.id}: avg ${avgChars.toFixed(1)} chars/page over ${pages.length} pages — proceeding without a text layer`,
        );
      }
    }

    const rows = buildOffsets(document.id, pages);
    for (let i = 0; i < rows.length; i += 500) {
      const { error: insErr } = await admin
        .from("document_text")
        .insert(rows.slice(i, i + 500));
      if (insErr) throw new Error(insErr.message);
    }

    // Persist non-text elements: image bytes into storage, rows with the
    // placeholder ranges so highlights can anchor to them.
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
        if (elErr) throw new Error(elErr.message);
      }
    }

    await admin
      .from("documents")
      .update({ status: "ready", pdf_path: pdfPath })
      .eq("id", document.id);

    // AI layer (markdown copy, RAG chunks, summary) builds in the background —
    // the reader opens instantly and AI features activate seconds later.
    if (env.hasOpenAI) {
      const { prepareDocumentAi } = await import("@/lib/aiprep");
      void prepareDocumentAi(document.id);
    }

    return NextResponse.json({ ...document, status: "ready", pdf_path: pdfPath }, { status: 201 });
  } catch (err) {
    console.error("processing failed", err);
    // A document must NEVER stay in "processing" after an error — even if this
    // update itself fails, swallow that failure so the original error surfaces
    // (the recents route additionally reaps stale processing rows as failed).
    try {
      await admin.from("documents").update({ status: "failed" }).eq("id", document.id);
    } catch (updateErr) {
      console.error("could not mark document failed", updateErr);
    }
    if (err instanceof ApiError) throw err;
    // Map known pdf-parse/pdf.js failures to human messages; the raw error
    // stays in the server log above for diagnosis.
    const raw = err instanceof Error ? err.message : String(err);
    if (/password/i.test(raw)) {
      throw new ApiError(
        422,
        "This PDF is password-protected. Remove the password and upload again.",
      );
    }
    if (extractedAsPdf && /invalid|corrupt|bad xref|unexpected/i.test(raw)) {
      throw new ApiError(422, "This file appears to be corrupted or is not a valid PDF.");
    }
    throw new ApiError(422, "The file could not be processed.");
  }
});
