import { aiEmbed, aiJson } from "@/lib/ai";
import {
  answerHeader,
  docTokenCount,
  documentBlock,
  warmDocumentCache,
} from "@/lib/answer";
import { env } from "@/lib/env";
import { pageForOffset } from "@/lib/extract";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import type { DocumentAiMeta, DocumentElementRow, DocumentTextRow } from "@/lib/types";

/**
 * AI preparation pipeline, run once per document (async, after upload):
 *  1. a parallel MARKDOWN rendering for models — display text is never touched
 *  2. retrieval CHUNKS with exact global char offsets + embeddings (pgvector)
 *  3. a hybrid SUMMARY: small JSON "technical sheet" + hierarchical markdown
 */

const CHUNK_TARGET_CHARS = 6000; // ~1500 tokens (RAG serves only OVERSIZED docs in V2)
const CHUNK_OVERLAP_CHARS = 800; // ~200 tokens
const SUMMARY_SINGLE_SHOT_CHARS = 240_000; // ~60k tokens fits one mini call
const SUMMARY_BLOCK_CHARS = 160_000;

/* ------------------------------------------------------------- markdown */

const HEADING_NUMBERED = /^\s*(\d+(?:\.\d+)*)[.)]?\s+\S/;

function looksLikeHeading(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > 80) return false;
  if (/[.,;:]$/.test(t)) return false;
  if (HEADING_NUMBERED.test(t)) return true;
  // Short standalone line, capitalised, no sentence structure.
  return t.length < 60 && /^[A-Z0-9ĂÎȘȚÂ]/.test(t) && t.split(/\s+/).length <= 8 && !/[a-z][.!?] [A-Z]/.test(t);
}

function tableToPipes(contentText: string): string {
  const rows = contentText.split("\n").map((r) => r.split(" | "));
  if (rows.length === 0) return contentText;
  const [head, ...body] = rows;
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(head), `| ${head.map(() => "---").join(" | ")} |`, ...body.map(line)].join("\n");
}

/**
 * Model-facing rendering of a text slice: element markers become real pipe
 * tables / image notes, heading-looking lines get "## ". Offsets into the
 * ORIGINAL text are preserved by the caller; this is presentation only.
 */
export function mdifySlice(slice: string, elements: DocumentElementRow[]): string {
  let out = slice;
  for (const el of elements) {
    const marker = `[${el.kind === "image" ? "Image" : "Table"} ${el.element_no}]`;
    if (!out.includes(marker)) continue;
    const replacement =
      el.kind === "table" && el.content_text
        ? `\n\n${tableToPipes(el.content_text)}\n\n`
        : `\n\n*(figure ${el.element_no}${el.caption ? `: ${el.caption}` : ""})*\n\n`;
    out = out.split(marker).join(replacement);
  }
  return out
    .split("\n")
    .map((line) => (looksLikeHeading(line) ? `## ${line.trim()}` : line))
    .join("\n");
}

/** Full markdown copy with page markers (for the summary + as the "md copy"). */
export function buildDocumentMarkdown(
  pages: DocumentTextRow[],
  elements: DocumentElementRow[],
): string {
  return pages
    .map((p) => `<!-- page ${p.page_no} -->\n\n${mdifySlice(p.text, elements)}`)
    .join("\n\n");
}

/* -------------------------------------------------------------- chunking */

export interface PreparedChunk {
  idx: number;
  text: string; // model-facing (mdified)
  heading: string | null;
  char_start: number; // exact offsets into the original full text
  char_end: number;
  page_from: number;
  page_to: number;
}

/**
 * Split the ORIGINAL full text at paragraph boundaries into ~800-token chunks
 * (one-paragraph overlap), then mdify each chunk's text for the model. The
 * offsets always index the original string — the highlight coordinate system.
 */
export function chunkDocument(
  pages: DocumentTextRow[],
  fullText: string,
  elements: DocumentElementRow[],
): PreparedChunk[] {
  interface Para {
    start: number;
    end: number;
    text: string;
  }
  const paras: Para[] = [];
  const re = /\n{2,}/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  const push = (start: number, end: number) => {
    const text = fullText.slice(start, end);
    if (text.trim().length > 0) paras.push({ start, end, text });
  };
  while ((m = re.exec(fullText)) !== null) {
    push(cursor, m.index);
    cursor = m.index + m[0].length;
  }
  push(cursor, fullText.length);

  const chunks: PreparedChunk[] = [];
  let current: Para[] = [];
  let currentLen = 0;
  let lastHeading: string | null = null;

  const flush = () => {
    if (current.length === 0) return;
    const start = current[0].start;
    const end = current[current.length - 1].end;
    chunks.push({
      idx: chunks.length,
      text: mdifySlice(fullText.slice(start, end), elements),
      heading: lastHeading,
      char_start: start,
      char_end: end,
      page_from: pageForOffset(pages, start)?.page_no ?? 1,
      page_to: pageForOffset(pages, Math.max(start, end - 1))?.page_no ?? 1,
    });
  };

  for (const para of paras) {
    const firstLine = para.text.split("\n", 1)[0];
    if (looksLikeHeading(firstLine)) lastHeading = firstLine.trim();
    if (currentLen > 0 && currentLen + para.text.length > CHUNK_TARGET_CHARS) {
      flush();
      // ~200-token overlap so boundary content is never orphaned
      const kept: Para[] = [];
      let keptLen = 0;
      for (let i = current.length - 1; i >= 0 && keptLen < CHUNK_OVERLAP_CHARS; i--) {
        kept.unshift(current[i]);
        keptLen += current[i].text.length;
      }
      current = kept;
      currentLen = keptLen;
    }
    current.push(para);
    currentLen += para.text.length;
  }
  flush();
  return chunks;
}

/* --------------------------------------------------------------- summary */

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["doc_type", "language", "domain", "key_entities", "structure", "summary_md"],
  properties: {
    doc_type: {
      type: "string",
      description: "e.g. scientific_article, book_fiction, book_nonfiction, contract, manual, report, other",
    },
    language: { type: "string", description: "ISO 639-1 of the document language" },
    domain: { type: "string", description: "subject area in 1-3 words" },
    key_entities: { type: "array", items: { type: "string" }, description: "5-12 central names/terms" },
    structure: {
      type: "array",
      description: "table of contents: each section/chapter with its start page",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "page"],
        properties: { title: { type: "string" }, page: { type: "integer" } },
      },
    },
    summary_md: {
      type: "string",
      description:
        "Markdown: a 150-300 word global summary, then '## Sections' with 1-2 sentences per section including page refs like (p. 4). Written in the document's language.",
    },
  },
} as const;

type SummaryOut = DocumentAiMeta & { summary_md: string };

async function summarize(markdown: string, title: string): Promise<SummaryOut> {
  const system =
    "You produce a faithful, information-dense technical sheet and summary of a document for another AI to use as a map. Never invent content; keep every load-bearing claim. Use the page markers (<!-- page N -->) for page references.";

  if (markdown.length <= SUMMARY_SINGLE_SHOT_CHARS) {
    const { value } = await aiJson<SummaryOut>({
      model: env.modelUtility,
      system,
      input: `Document title: ${title}\n\n${markdown}`,
      effort: "low",
      schemaName: "document_summary",
      schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>,
    });
    return value;
  }

  // Map-reduce for very long documents: per-block digests, then one combine.
  // Budget scales with size: ~150 words per 10 pages of the block.
  const { aiText } = await import("@/lib/ai");
  const digests: string[] = [];
  for (let i = 0; i < markdown.length; i += SUMMARY_BLOCK_CHARS) {
    const block = markdown.slice(i, i + SUMMARY_BLOCK_CHARS);
    const blockPages = Math.max(1, (block.match(/<!-- page /g) ?? []).length);
    const wordBudget = Math.max(150, Math.round((blockPages / 10) * 150));
    const { text } = await aiText({
      model: env.modelUtility,
      system: `Summarise this document portion densely in its own language: every section title with its page marker, main claims, key entities. About ${wordBudget} words.`,
      input: block,
      effort: "low",
      maxOutputTokens: Math.min(12000, wordBudget * 3 + 1500),
    });
    digests.push(text);
  }
  const { value } = await aiJson<SummaryOut>({
    model: env.modelUtility,
    system,
    input: `Document title: ${title}\n\nPortion digests, in order:\n\n${digests.join("\n\n---\n\n")}`,
    effort: "low",
    schemaName: "document_summary",
    schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>,
  });
  return value;
}

/* -------------------------------------------------------------- pipeline */

export function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** Run the whole preparation for one document. Safe to re-run (idempotent). */
export async function prepareDocumentAi(documentId: string): Promise<void> {
  const admin = createSupabaseAdmin();
  await admin
    .from("document_ai")
    .upsert({ document_id: documentId, status: "pending", error: null });

  try {
    const [{ data: doc }, { data: pageRows }, { data: elementRows }] = await Promise.all([
      admin.from("documents").select("*").eq("id", documentId).maybeSingle(),
      admin.from("document_text").select("*").eq("document_id", documentId).order("page_no"),
      admin.from("document_elements").select("*").eq("document_id", documentId),
    ]);
    if (!doc || !pageRows || pageRows.length === 0) throw new Error("Document has no text");
    const elements = elementRows ?? [];
    const fullText = pageRows.map((p) => p.text).join("");

    const markdown = buildDocumentMarkdown(pageRows, elements);
    const chunks = chunkDocument(pageRows, fullText, elements);
    const embeddings = await aiEmbed(chunks.map((c) => c.text));

    await admin.from("document_chunks").delete().eq("document_id", documentId);
    for (let i = 0; i < chunks.length; i += 200) {
      const batch = chunks.slice(i, i + 200).map((c, j) => ({
        document_id: documentId,
        idx: c.idx,
        text: c.text,
        heading: c.heading,
        char_start: c.char_start,
        char_end: c.char_end,
        page_from: c.page_from,
        page_to: c.page_to,
        embedding: vectorLiteral(embeddings[i + j]),
      }));
      const { error } = await admin.from("document_chunks").insert(batch);
      if (error) throw new Error(error.message);
    }

    const summary = await summarize(markdown, doc.title);
    const { summary_md, ...meta } = summary;

    const { error: upErr } = await admin.from("document_ai").upsert({
      document_id: documentId,
      status: "ready",
      markdown,
      summary_md,
      summary_meta: meta,
      error: null,
      updated_at: new Date().toISOString(),
    });
    if (upErr) throw new Error(upErr.message);

    // The reader's keep-warm pings that fired DURING prep cached the
    // pages-fallback prefix; from now on answers use the markdown prefix.
    // Warm the final prefix on every lane immediately, so the first question
    // after prep does not pay cold-input prices (measured live: it did).
    if (docTokenCount(pageRows) <= env.docFullContextMaxTokens) {
      const docBlock = documentBlock(
        pageRows,
        markdown,
        answerHeader(doc, meta as { doc_type: string; language: string }),
      );
      await Promise.all([
        warmDocumentCache(docBlock, documentId, "low"),
        warmDocumentCache(docBlock, documentId, "medium"),
        warmDocumentCache(docBlock, documentId, "low", "low"),
        warmDocumentCache(docBlock, documentId, "medium", "low"),
      ]).catch((e) => console.error("post-prep warm failed:", e));
      console.log(`[warm] post-prep doc=${documentId.slice(0, 8)} (markdown prefix)`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`AI prep failed for ${documentId}:`, message);
    await admin.from("document_ai").upsert({
      document_id: documentId,
      status: "failed",
      error: message.slice(0, 500),
      updated_at: new Date().toISOString(),
    });
  }
}
