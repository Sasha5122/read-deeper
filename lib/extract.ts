import type { DocumentKind, DocumentTextRow } from "@/lib/types";

/** Target size of a synthetic page for formats without native pages. */
const PAGE_CHARS = 3500;

export interface ExtractedPage {
  page_no: number;
  text: string;
}

export interface ExtractedElement {
  kind: "image" | "table";
  element_no: number;
  /** Placeholder that appears verbatim in the text layer, e.g. "[Image 2]". */
  marker: string;
  /** Image bytes (when resolvable). */
  buffer?: Buffer;
  mime?: string;
  /** Table content as plain text rows ("a | b | c" per line). */
  content_text?: string;
}

export interface ExtractedDocument {
  pages: ExtractedPage[];
  elements: ExtractedElement[];
}

/** Collects non-text elements and hands out their placeholder markers. */
class ElementCollector {
  elements: ExtractedElement[] = [];
  private imageNo = 0;
  private tableNo = 0;

  image(buffer: Buffer | undefined, mime: string | undefined): string {
    const element_no = ++this.imageNo;
    const marker = `[Image ${element_no}]`;
    this.elements.push({ kind: "image", element_no, marker, buffer, mime });
    return marker;
  }

  table(content_text: string): string {
    const element_no = ++this.tableNo;
    const marker = `[Table ${element_no}]`;
    this.elements.push({ kind: "table", element_no, marker, content_text });
    return marker;
  }
}

/**
 * Extract text AND non-text elements (images, tables) from an uploaded file.
 * Elements become standalone placeholder paragraphs in the text layer, so
 * offsets, highlights and threads work on them exactly like on text.
 */
export async function extractDocument(
  buffer: Buffer,
  kind: DocumentKind,
): Promise<ExtractedDocument> {
  const collector = new ElementCollector();
  switch (kind) {
    case "pdf": {
      const pages = await pdfExtract(buffer, collector);
      return { pages, elements: collector.elements };
    }
    case "docx": {
      const mammoth = await import("mammoth");
      const { value: html } = await mammoth.convertToHtml(
        { buffer },
        {
          convertImage: mammoth.images.imgElement(async (img) => ({
            src: `data:${img.contentType};base64,${await img.readAsBase64String()}`,
          })),
        },
      );
      const text = await htmlToTextRich(html, collector, resolveDataUri);
      return { pages: paginate(normalize(text)), elements: collector.elements };
    }
    case "doc": {
      const WordExtractor = (await import("word-extractor")).default;
      const extractor = new WordExtractor();
      const docFile = await extractor.extract(buffer);
      return { pages: paginate(normalize(docFile.getBody())), elements: [] };
    }
    case "rtf":
      return { pages: paginate(normalize(rtfToText(buffer.toString("utf-8")))), elements: [] };
    case "html": {
      const text = await htmlToTextRich(buffer.toString("utf-8"), collector, resolveDataUri);
      return { pages: paginate(normalize(text)), elements: collector.elements };
    }
    case "odt":
      return { pages: paginate(normalize(await odtToText(buffer))), elements: [] };
    case "epub": {
      const text = await epubToText(buffer, collector);
      return { pages: paginate(normalize(text)), elements: collector.elements };
    }
    case "mobi": {
      const text = await mobiToText(buffer, collector);
      return { pages: paginate(normalize(text)), elements: collector.elements };
    }
    case "txt":
      return { pages: paginate(normalize(buffer.toString("utf-8"))), elements: [] };
  }
}

/** Back-compat helper for callers that only need the text layer. */
export async function extractPages(buffer: Buffer, kind: DocumentKind): Promise<ExtractedPage[]> {
  return (await extractDocument(buffer, kind)).pages;
}

/**
 * Locate each element's placeholder in the document's full text.
 * Returns elements with global char ranges, in document order.
 */
export function locateElements(
  fullText: string,
  elements: ExtractedElement[],
): (ExtractedElement & { char_start: number; char_end: number })[] {
  // Markers are unique per document ("[Image 3]", "[Table 1]"), and collection
  // order can differ from document order — search each from the start.
  const located: (ExtractedElement & { char_start: number; char_end: number })[] = [];
  for (const el of elements) {
    const idx = fullText.indexOf(el.marker);
    if (idx === -1) continue;
    located.push({ ...el, char_start: idx, char_end: idx + el.marker.length });
  }
  return located.sort((a, b) => a.char_start - b.char_start);
}

export function normalize(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      // soft hyphen: invisible line-break hints common in ebooks/PDFs
      .replace(/\u00ad/g, "")
      // null bytes and other control chars (except newline and tab) get
      // stripped: real-world PDFs contain them and Postgres rejects u0000
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
  );
}


function ensureTerminated(text: string): string {
  const trimmed = text.replace(/\s+$/, "");
  return trimmed.length > 0 ? `${trimmed}\n\n` : "";
}

/* ------------------------------------------------------------------- pdf */

async function pdfExtract(buffer: Buffer, collector: ElementCollector): Promise<ExtractedPage[]> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const textResult = await parser.getText();

  const tablesByPage = new Map<number, string[]>();
  const imagesByPage = new Map<number, { buffer: Buffer; mime: string }[]>();
  try {
    const tableResult = await parser.getTable();
    for (const page of tableResult.pages) {
      tablesByPage.set(
        page.num,
        page.tables.map((t) => t.map((row) => row.join(" | ")).join("\n")),
      );
    }
  } catch {
    // table detection is best-effort
  }
  try {
    const imageResult = await parser.getImage();
    for (const page of imageResult.pages) {
      imagesByPage.set(
        page.pageNumber,
        page.images
          .filter((img) => img.data && img.data.length > 0)
          .map((img) => ({
            buffer: Buffer.from(img.data),
            mime: /^data:([^;]+)/.exec(img.dataUrl ?? "")?.[1] ?? "image/png",
          })),
      );
    }
  } catch {
    // image extraction is best-effort
  }

  return textResult.pages.map((p) => {
    let text = normalize(p.text).replace(/\s+$/, "");
    for (const tableText of tablesByPage.get(p.num) ?? []) {
      if (tableText.trim().length === 0) continue;
      text += `\n\n${collector.table(normalize(tableText))}`;
    }
    for (const img of imagesByPage.get(p.num) ?? []) {
      text += `\n\n${collector.image(img.buffer, img.mime)}`;
    }
    return { page_no: p.num, text: ensureTerminated(text) };
  });
}

/* ------------------------------------------------------------------ html */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => ENTITIES[name] ?? m);
}

/** Convert HTML/XHTML to readable plain text with paragraph breaks. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|head|nav|svg)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|figcaption|dt|dd|pre)>/gi, "\n\n")
      .replace(/<(p|div|h[1-6]|li|tr|blockquote|section|article|ul|ol|table)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type SrcResolver = (src: string) => Promise<{ buffer: Buffer; mime: string } | null>;

/** Decode data: URIs (base64 or percent-encoded). */
export const resolveDataUri: SrcResolver = async (src) => {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src.trim());
  if (!m) return null;
  const mime = m[1];
  const payload = m[3];
  const buffer = m[2]
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf-8");
  return buffer.length > 0 ? { buffer, mime } : null;
};

/**
 * Like htmlToText, but tables and images become collected elements with
 * placeholder markers at their exact position in the text flow.
 */
export async function htmlToTextRich(
  html: string,
  collector: ElementCollector,
  resolveSrc: SrcResolver,
): Promise<string> {
  let work = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|nav)\b[\s\S]*?<\/\1>/gi, "");

  // Tables first (their cells are plain text, never nested elements for us).
  work = work.replace(/<table\b[\s\S]*?<\/table>/gi, (tableHtml) => {
    const rows: string[] = [];
    const trRe = /<tr\b[\s\S]*?<\/tr>/gi;
    let tr: RegExpExecArray | null;
    while ((tr = trRe.exec(tableHtml)) !== null) {
      const cells: string[] = [];
      const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cell: RegExpExecArray | null;
      while ((cell = cellRe.exec(tr[0])) !== null) {
        cells.push(htmlToText(cell[1]).replace(/\n+/g, " ").trim());
      }
      if (cells.length > 0) rows.push(cells.join(" | "));
    }
    const content = rows.join("\n").trim();
    if (content.length === 0) return "\n\n";
    return `\n\n${collector.table(content)}\n\n`;
  });

  // Standalone SVG graphics count as images too.
  work = work.replace(/<svg\b[\s\S]*?<\/svg>/gi, (svgHtml) => {
    const buffer = Buffer.from(svgHtml, "utf-8");
    return `\n\n${collector.image(buffer, "image/svg+xml")}\n\n`;
  });

  // Images: resolve src (async) then substitute markers.
  const imgTags = [...work.matchAll(/<img\b[^>]*>/gi)];
  const substitutions = new Map<string, string>();
  for (const [i, m] of imgTags.entries()) {
    const src = /\bsrc\s*=\s*"([^"]*)"|\bsrc\s*=\s*'([^']*)'/i.exec(m[0]);
    const srcValue = src?.[1] ?? src?.[2] ?? "";
    const resolved = srcValue ? await resolveSrc(srcValue) : null;
    const token = `IMG${i}`;
    substitutions.set(token, `\n\n${collector.image(resolved?.buffer, resolved?.mime)}\n\n`);
    work = work.replace(m[0], token);
  }
  for (const [token, replacement] of substitutions) {
    work = work.replace(token, replacement);
  }

  return htmlToText(work);
}

/* ------------------------------------------------------------------- rtf */

const RTF_SKIP_DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "info",
  "pict",
  "header",
  "footer",
  "themedata",
  "colorschememapping",
  "latentstyles",
  "datastore",
  "listtable",
  "listoverridetable",
  "generator",
  "xmlnstbl",
]);

/** Minimal RTF-to-text: control words stripped, \par kept as breaks. */
export function rtfToText(rtf: string): string {
  let out = "";
  let i = 0;
  let skipDepth = 0; // inside a destination group we ignore (font table etc.)
  let depth = 0;
  const skipStack: number[] = [];

  while (i < rtf.length) {
    const ch = rtf[i];
    if (ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}") {
      if (skipStack.length > 0 && skipStack[skipStack.length - 1] === depth) {
        skipStack.pop();
        skipDepth--;
      }
      depth--;
      i++;
      continue;
    }
    if (ch === "\\") {
      const rest = rtf.slice(i + 1);
      // \'hh — encoded character
      const hex = /^'([0-9a-fA-F]{2})/.exec(rest);
      if (hex) {
        if (skipDepth === 0) out += String.fromCharCode(parseInt(hex[1], 16));
        i += 4; // backslash + apostrophe + two hex digits
        continue;
      }
      // \\ \{ \} escapes
      if (rest[0] === "\\" || rest[0] === "{" || rest[0] === "}") {
        if (skipDepth === 0) out += rest[0];
        i += 2;
        continue;
      }
      const word = /^\*?([a-zA-Z]+)(-?\d+)?[ ]?/.exec(rest);
      if (word) {
        const name = word[1];
        if (rest.startsWith("*") || RTF_SKIP_DESTINATIONS.has(name)) {
          if (skipDepth === 0 || skipStack[skipStack.length - 1] !== depth) {
            skipStack.push(depth);
            skipDepth++;
          }
        } else if (skipDepth === 0) {
          if (name === "par" || name === "sect" || name === "page") out += "\n\n";
          else if (name === "line") out += "\n";
          else if (name === "tab") out += "\t";
          else if (name === "u" && word[2]) {
            out += String.fromCodePoint(((Number(word[2]) % 65536) + 65536) % 65536);
            // consume the replacement character that follows \uN
            i += 1 + word[0].length;
            if (rtf[i] === "?") i++;
            continue;
          }
        }
        i += 1 + word[0].length;
        continue;
      }
      i += 2;
      continue;
    }
    if (skipDepth === 0 && ch !== "\n" && ch !== "\r") out += ch;
    i++;
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/* ------------------------------------------------------------------- odt */

async function odtToText(buffer: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const content = await zip.file("content.xml")?.async("string");
  if (!content) throw new Error("Not a valid ODT file (missing content.xml)");
  return decodeEntities(
    content
      .replace(/<text:line-break\s*\/>/g, "\n")
      .replace(/<text:tab\s*\/>/g, "\t")
      .replace(/<\/text:(p|h)>/g, "\n\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ------------------------------------------------------------------ epub */

async function epubToText(buffer: Buffer, collector: ElementCollector): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);

  const container = await zip.file("META-INF/container.xml")?.async("string");
  if (!container) throw new Error("Not a valid EPUB (missing container.xml)");
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath) throw new Error("Not a valid EPUB (no OPF path)");
  const opf = await zip.file(opfPath)?.async("string");
  if (!opf) throw new Error("Not a valid EPUB (missing OPF)");
  const baseDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

  const hrefById = new Map<string, string>();
  const itemRe = /<item\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(opf)) !== null) {
    const tag = m[0];
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    const type = /\bmedia-type="([^"]+)"/.exec(tag)?.[1] ?? "";
    if (id && href && (type.includes("html") || type.includes("xml"))) hrefById.set(id, href);
  }

  const chapters: string[] = [];
  const refRe = /<itemref\b[^>]*\bidref="([^"]+)"[^>]*>/g;
  while ((m = refRe.exec(opf)) !== null) {
    const href = hrefById.get(m[1]);
    if (!href) continue;
    const chapterPath = normalizeZipPath(baseDir + decodeURIComponent(href.split("#")[0]));
    const html = await zip.file(chapterPath)?.async("string");
    if (!html) continue;
    const chapterDir = chapterPath.includes("/")
      ? chapterPath.slice(0, chapterPath.lastIndexOf("/") + 1)
      : "";
    const resolver: SrcResolver = async (src) => {
      const fromData = await resolveDataUri(src);
      if (fromData) return fromData;
      const file = zip.file(normalizeZipPath(chapterDir + decodeURIComponent(src.split("#")[0])));
      if (!file) return null;
      const bytes = await file.async("uint8array");
      return { buffer: Buffer.from(bytes), mime: mimeFromPath(src) };
    };
    const text = await htmlToTextRich(html, collector, resolver);
    if (text.length > 0) chapters.push(text);
  }
  if (chapters.length === 0) throw new Error("No readable chapters found in EPUB");
  return chapters.join("\n\n");
}

function normalizeZipPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
  };
  return map[ext] ?? "image/png";
}

/* ------------------------------------------------------------------ mobi */

interface MobiBook {
  getSpine(): { id: string }[];
  loadChapter(id: string): { html: string } | undefined;
  destroy(): void;
}

/**
 * The parser's Kf8.replace() indexes regex matches without null checks and
 * throws on chapters whose <link>/<head> don't follow the kindle: pattern
 * (Project Gutenberg AZW3s, for instance). Wrap it once so such chapters
 * degrade to their raw <body> text instead of being lost.
 */
function hardenMobiBook(book: MobiBook): void {
  const proto = Object.getPrototypeOf(book) as {
    __rdSafe?: boolean;
    replace?: (str: string) => unknown;
  };
  if (!proto.replace || proto.__rdSafe) return;
  const orig = proto.replace;
  proto.replace = function (str: string) {
    try {
      return orig.call(this, str);
    } catch {
      const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(str)?.[1] ?? str;
      return { html: body, css: [] };
    }
  };
  proto.__rdSafe = true;
}

async function mobiToText(buffer: Buffer, collector: ElementCollector): Promise<string> {
  const { initMobiFile, initKf8File } = await import("@lingo-reader/mobi-parser");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const fs = await import("node:fs/promises");
  const data = new Uint8Array(buffer);

  const resolver: SrcResolver = async (src) => {
    const fromData = await resolveDataUri(src);
    if (fromData) return fromData;
    try {
      const bytes = await fs.readFile(src);
      return { buffer: Buffer.from(bytes), mime: mimeFromPath(src) };
    } catch {
      return null;
    }
  };

  const readBook = async (
    init: (d: Uint8Array, dir: string) => Promise<unknown>,
    tag: string,
  ): Promise<string | null> => {
    let book: MobiBook;
    try {
      book = (await init(data, join(tmpdir(), `rd-mobi-${tag}-${Date.now()}`))) as MobiBook;
    } catch {
      return null;
    }
    hardenMobiBook(book);
    try {
      const chapters: string[] = [];
      for (const item of book.getSpine()) {
        try {
          const chapter = book.loadChapter(item.id);
          if (!chapter) continue;
          // some chapters arrive with a mangled XML prolog remnant before the markup
          const html = chapter.html.replace(/^\s*[^<]{0,80}\?>\s*/, "");
          const text = await htmlToTextRich(html, collector, resolver);
          if (text.length > 0) chapters.push(text);
        } catch {
          // one broken chapter must not sink the whole book
        }
      }
      return chapters.length > 0 ? chapters.join("\n\n") : null;
    } finally {
      book.destroy();
    }
  };

  // Dual-format files (MOBI7 + KF8 in one container) open fine as legacy MOBI
  // but expose only a stub there — so read BOTH and keep the richer result.
  const asMobi = await readBook(initMobiFile, "m");
  const asKf8 =
    asMobi !== null && asMobi.length >= 2000 ? null : await readBook(initKf8File, "k");
  const text = (asKf8?.length ?? 0) > (asMobi?.length ?? 0) ? asKf8 : asMobi;
  if (!text) throw new Error("No readable chapters found in MOBI");
  return text;
}

/* ------------------------------------------------------------ pagination */

/** Split plain text into synthetic pages at paragraph boundaries. */
export function paginate(text: string, pageChars: number = PAGE_CHARS): ExtractedPage[] {
  const paragraphs = text.split(/\n{2,}/);
  const pages: ExtractedPage[] = [];
  let current = "";

  const flush = () => {
    if (current.trim().length > 0) {
      pages.push({ page_no: pages.length + 1, text: ensureTerminated(current) });
    }
    current = "";
  };

  for (const para of paragraphs) {
    const chunk = para.trim();
    if (chunk.length === 0) continue;
    if (current.length > 0 && current.length + chunk.length + 2 > pageChars) flush();
    current = current.length > 0 ? `${current}\n\n${chunk}` : chunk;
    // A single paragraph larger than a page becomes its own page.
    if (current.length >= pageChars) flush();
  }
  flush();
  return pages;
}

/**
 * Assign global character offsets. The document's full text is exactly the
 * concatenation of page texts in order — the reader and the context builder
 * both rely on this identity.
 */
export function buildOffsets(
  documentId: string,
  pages: ExtractedPage[],
): Omit<DocumentTextRow, never>[] {
  let cursor = 0;
  return pages.map((p) => {
    const row: DocumentTextRow = {
      document_id: documentId,
      page_no: p.page_no,
      text: p.text,
      char_start: cursor,
      char_end: cursor + p.text.length,
    };
    cursor += p.text.length;
    return row;
  });
}

/** Reassemble the full document text from ordered page rows. */
export function fullTextOf(pages: Pick<DocumentTextRow, "text">[]): string {
  return pages.map((p) => p.text).join("");
}

/** Find which page a global offset falls on. */
export function pageForOffset(pages: DocumentTextRow[], offset: number): DocumentTextRow | null {
  for (const p of pages) {
    if (offset >= p.char_start && offset < p.char_end) return p;
  }
  return pages.length > 0 ? pages[pages.length - 1] : null;
}
