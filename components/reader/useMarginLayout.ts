"use client";

import { useCallback, useLayoutEffect, useState, type RefObject } from "react";
import type { HighlightWithThread } from "@/lib/types";

export interface CardPosition {
  /** Card top in CONTAINER coordinates (what the connectors use). */
  top: number;
  /** Card top in margin-column coordinates (what style.top must use). */
  cardTop: number;
  /** y of the highlight's first mark, relative to the reader container. */
  anchorY: number;
  /** Bottom of the mark's first line — the inter-line gap the connector runs through. */
  anchorBottom: number;
  anchorRight: number;
  /** Exact left edge of this card, measured from the DOM. */
  cardX: number;
}

const CARD_GAP = 10;
const COLLAPSED_HEIGHT = 40;

/**
 * Position margin cards next to their highlight's y. Overlapping cards are
 * pushed down in document order; the active card keeps priority by being
 * measured at its real (expanded) height.
 */
function samePositions(a: Map<string, CardPosition>, b: Map<string, CardPosition>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w) return false;
    if (
      Math.abs(v.top - w.top) > 0.5 ||
      Math.abs(v.anchorY - w.anchorY) > 0.5 ||
      Math.abs(v.anchorBottom - w.anchorBottom) > 0.5 ||
      Math.abs(v.anchorRight - w.anchorRight) > 0.5 ||
      Math.abs(v.cardX - w.cardX) > 0.5 ||
      Math.abs(v.cardTop - w.cardTop) > 0.5
    ) {
      return false;
    }
  }
  return true;
}

export function useMarginLayout(
  containerRef: RefObject<HTMLElement | null>,
  highlights: HighlightWithThread[],
  activeId: string | null,
  /** Anything that changes card heights (streaming text, new messages). */
  layoutEpoch: number,
) {
  const [positions, setPositions] = useState<Map<string, CardPosition>>(new Map());

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    // Cards are absolutely positioned inside the margin column, whose origin
    // sits below the container's padding — convert between the two frames.
    const marginCol = container.querySelector<HTMLElement>("[data-margin-col]");
    const marginOffsetTop = marginCol
      ? marginCol.getBoundingClientRect().top - containerRect.top
      : 0;

    const anchors: { id: string; anchorY: number; anchorBottom: number; anchorRight: number }[] =
      [];
    for (const h of highlights) {
      const marks = container.querySelectorAll<HTMLElement>(`[data-hl="${h.id}"]`);
      if (marks.length === 0) continue;
      // Card placement aligns with where the highlight STARTS…
      const firstRects = marks[0].getClientRects();
      const first = firstRects.item(0) ?? marks[0].getBoundingClientRect();
      // …but the connector always leaves from the LAST marked word: the final
      // rendered line box of the final mark element.
      const lastMark = marks[marks.length - 1];
      const lastRects = lastMark.getClientRects();
      const last = lastRects.item(lastRects.length - 1) ?? lastMark.getBoundingClientRect();
      anchors.push({
        id: h.id,
        anchorY: first.top - containerRect.top,
        anchorBottom: last.bottom - containerRect.top,
        anchorRight: last.right - containerRect.left,
      });
    }
    anchors.sort((a, b) => a.anchorY - b.anchorY);

    const next = new Map<string, CardPosition>();
    let cursor = 0;
    for (const a of anchors) {
      const card = container.querySelector<HTMLElement>(`[data-card="${a.id}"]`);
      const height = card?.offsetHeight ?? COLLAPSED_HEIGHT;
      const cardX = card
        ? card.getBoundingClientRect().left - containerRect.left
        : containerRect.width;
      const top = Math.max(a.anchorY, cursor);
      next.set(a.id, {
        top,
        cardTop: top - marginOffsetTop,
        anchorY: a.anchorY,
        anchorBottom: a.anchorBottom,
        anchorRight: a.anchorRight,
        cardX,
      });
      cursor = top + height + CARD_GAP;
    }
    setPositions((prev) => (samePositions(prev, next) ? prev : next));
  }, [containerRef, highlights]);

  useLayoutEffect(() => {
    measure();
    // Re-measure after fonts/images settle and on resize.
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(container);
    return () => ro.disconnect();
  }, [measure, activeId, layoutEpoch]);

  return { positions, remeasure: measure };
}
