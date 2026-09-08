"use client";

import { memo } from "react";
import { segmentParagraph, type HighlightSegmentSpec, type Paragraph } from "./offsets";
import { ElementBlock, type ReaderElement } from "./ElementBlock";

interface TextLayerProps {
  paragraphs: Paragraph[];
  highlights: HighlightSegmentSpec[];
  /** Search hits, rendered above highlights (colors: search-hit / search-current). */
  searchSpecs?: HighlightSegmentSpec[];
  /** Non-text elements (images/tables) anchored in the text flow. */
  elements?: ReaderElement[];
  activeId: string | null;
  onHighlightClick: (highlightId: string) => void;
}

/** The document's own HTML text layer — plain paragraphs with highlight spans. */
export const TextLayer = memo(function TextLayer({
  paragraphs,
  highlights,
  searchSpecs = [],
  elements = [],
  activeId,
  onHighlightClick,
}: TextLayerProps) {
  const elementByStart = new Map(elements.map((el) => [el.char_start, el]));
  // Search spans come first so they win overlaps against highlights.
  const specs = searchSpecs.length > 0 ? [...searchSpecs, ...highlights] : highlights;
  const byPage = new Map<number, Paragraph[]>();
  for (const p of paragraphs) {
    const list = byPage.get(p.pageNo) ?? [];
    list.push(p);
    byPage.set(p.pageNo, list);
  }

  return (
    <div className="reading-column">
      {Array.from(byPage.entries()).map(([pageNo, paras]) => (
        <section key={pageNo} className="rd-page" data-page={pageNo}>
          {paras.map((para) => {
            const element = elementByStart.get(para.start);
            if (element && para.text.trim() === `[${element.kind === "image" ? "Image" : "Table"} ${element.element_no}]`) {
              return (
                <ElementBlock
                  key={para.key}
                  element={element}
                  para={para}
                  specs={specs}
                  activeId={activeId}
                  onHighlightClick={onHighlightClick}
                />
              );
            }
            return (
            <p key={para.key} data-pstart={para.start}>
              {segmentParagraph(para, specs).map((seg, i) =>
                seg.highlightId ? (
                  <mark
                    key={i}
                    data-hl={seg.highlightId}
                    className={`hl hl-${seg.color} ${seg.highlightId === activeId ? "hl-active" : ""} bg-transparent text-inherit`}
                    onClick={(e) => {
                      if (seg.highlightId!.startsWith("s-")) return; // search hit, not a thread
                      e.stopPropagation();
                      onHighlightClick(seg.highlightId!);
                    }}
                  >
                    {seg.text}
                  </mark>
                ) : (
                  <span key={i}>{seg.text}</span>
                ),
              )}
            </p>
            );
          })}
        </section>
      ))}
    </div>
  );
});
