"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { domToGlobalOffset } from "./offsets";

export interface TextSelection {
  start: number;
  end: number;
  /** Viewport rect of the selection, for placing the pen toolbar. */
  rect: DOMRect;
}

/** Track text selections inside the reading column as global char offsets. */
export function useSelection(articleRef: RefObject<HTMLElement | null>) {
  const [selection, setSelection] = useState<TextSelection | null>(null);

  const clear = useCallback(() => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  useEffect(() => {
    function onPointerUp() {
      // Let the browser finalize the selection first.
      requestAnimationFrame(() => {
        const sel = window.getSelection();
        const article = articleRef.current;
        if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !article) {
          setSelection(null);
          return;
        }
        const range = sel.getRangeAt(0);
        if (!article.contains(range.commonAncestorContainer)) {
          setSelection(null);
          return;
        }
        const a = domToGlobalOffset(range.startContainer, range.startOffset);
        const b = domToGlobalOffset(range.endContainer, range.endOffset);
        if (a === null || b === null || a === b) {
          setSelection(null);
          return;
        }
        // anchor the palette at the END of the selection: last non-empty rect
        const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0);
        setSelection({
          start: Math.min(a, b),
          end: Math.max(a, b),
          rect: rects.length ? rects[rects.length - 1] : range.getBoundingClientRect(),
        });
      });
    }
    document.addEventListener("mouseup", onPointerUp);
    document.addEventListener("touchend", onPointerUp);
    return () => {
      document.removeEventListener("mouseup", onPointerUp);
      document.removeEventListener("touchend", onPointerUp);
    };
  }, [articleRef]);

  return { selection, clear };
}
