import type { DocumentTextRow } from "@/lib/types";

export interface Paragraph {
  key: string;
  pageNo: number;
  /** Global char offset of the first character of this paragraph. */
  start: number;
  text: string;
}

/**
 * Split the page text layer into renderable paragraphs while preserving
 * global character offsets. The document's full text is the concatenation of
 * page texts; paragraph offsets index into that same string.
 */
export function buildParagraphs(pages: DocumentTextRow[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  for (const page of pages) {
    const re = /[^\n]+(?:\n(?!\n)[^\n]*)*/g; // runs of text not containing blank lines
    let match: RegExpExecArray | null;
    while ((match = re.exec(page.text)) !== null) {
      if (match[0].trim().length === 0) continue;
      paragraphs.push({
        key: `${page.page_no}:${match.index}`,
        pageNo: page.page_no,
        start: page.char_start + match.index,
        text: match[0],
      });
    }
  }
  return paragraphs;
}

/**
 * Convert a DOM position inside the text layer into a global char offset.
 * Paragraph elements carry data-pstart; their rendered text is the exact
 * substring of the document text starting there.
 */
export function domToGlobalOffset(node: Node, offsetInNode: number): number | null {
  const el = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)) ?? null;
  const para = el?.closest<HTMLElement>("[data-pstart]");
  if (!para) return null;
  const paraStart = Number(para.dataset.pstart);
  if (Number.isNaN(paraStart)) return null;

  let acc = 0;
  const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
  let current: Node | null;
  while ((current = walker.nextNode())) {
    if (current === node) return paraStart + acc + offsetInNode;
    acc += current.nodeValue?.length ?? 0;
  }
  // Position was the paragraph element itself (offset = child index).
  if (node === para) return paraStart + (offsetInNode === 0 ? 0 : acc);
  return null;
}

export interface HighlightSegmentSpec {
  id: string;
  color: string;
  start: number;
  end: number;
}

export interface Segment {
  text: string;
  highlightId: string | null;
  color: string | null;
}

/** Cut one paragraph's text into plain/highlighted segments. */
export function segmentParagraph(para: Paragraph, highlights: HighlightSegmentSpec[]): Segment[] {
  const pStart = para.start;
  const pEnd = para.start + para.text.length;
  const overlapping = highlights
    .filter((h) => h.start < pEnd && h.end > pStart)
    .sort((a, b) => a.start - b.start);
  if (overlapping.length === 0) {
    return [{ text: para.text, highlightId: null, color: null }];
  }

  const bounds = new Set<number>([pStart, pEnd]);
  for (const h of overlapping) {
    bounds.add(Math.max(pStart, h.start));
    bounds.add(Math.min(pEnd, h.end));
  }
  const sorted = Array.from(bounds).sort((a, b) => a - b);

  const segments: Segment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const s = sorted[i];
    const e = sorted[i + 1];
    if (e <= s) continue;
    const cover = overlapping.find((h) => h.start <= s && h.end >= e) ?? null;
    segments.push({
      text: para.text.slice(s - pStart, e - pStart),
      highlightId: cover?.id ?? null,
      color: cover?.color ?? null,
    });
  }
  return segments;
}
