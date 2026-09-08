"use client";

import { useEffect, useState } from "react";
import type { HighlightColor } from "@/lib/types";

const COLORS: { color: HighlightColor; swatch: string }[] = [
  { color: "amber", swatch: "#f0c956" },
  { color: "green", swatch: "#7ab87a" },
  { color: "blue", swatch: "#7a9ec7" },
  { color: "rose", swatch: "#d68a94" },
];

interface SelectionToolbarProps {
  /** Viewport rect of the LAST line of the selection at mouseup time. */
  rect: DOMRect;
  /** The reading area's scroll container — the palette follows its scroll. */
  scrollEl: HTMLElement | null;
  busy: boolean;
  /** Picking a colour immediately creates the highlight and opens its chat. */
  onPick: (color: HighlightColor) => void;
}

/**
 * Colour palette anchored at the END of the selected words. It is glued to
 * the text: scrolling moves it with the content (and hides it once the
 * anchor leaves the reading area), it never re-centers on the screen.
 */
export function SelectionToolbar({ rect, scrollEl, busy, onPick }: SelectionToolbarProps) {
  // Translate by how far the container has scrolled since the selection was made.
  const [dy, setDy] = useState(0);
  useEffect(() => {
    setDy(0);
    if (!scrollEl) return;
    const base = scrollEl.scrollTop;
    const onScroll = () => setDy(base - scrollEl.scrollTop);
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, [scrollEl, rect]);

  // Below the end of the last selected word; flips above only when the
  // selection ends too close to the bottom edge (decided once, then the
  // palette just rides along with the scroll).
  const baseTop =
    rect.bottom + 8 + 44 < window.innerHeight ? rect.bottom + 8 : rect.top - 48;
  const top = baseTop + dy;
  const left = Math.max(8, Math.min(rect.right + 6, window.innerWidth - 170));

  // Hide once the anchor scrolls out of the reading area.
  const areaTop = scrollEl ? scrollEl.getBoundingClientRect().top : 0;
  const hidden = top < areaTop || top > window.innerHeight - 12;

  return (
    <div
      role="toolbar"
      aria-label="Highlight selection"
      data-seltoolbar
      className="fixed z-50 flex items-center gap-2 rounded-lg bg-black px-2.5 py-2 shadow-lg"
      style={{ top, left, visibility: hidden ? "hidden" : "visible" }}
      onMouseUp={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        // keep the browser from collapsing the selection before the click lands
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {busy ? (
        <span className="px-2 text-sm text-white">…</span>
      ) : (
        COLORS.map(({ color, swatch }) => (
          <button
            key={color}
            aria-label={`Highlight ${color} and ask`}
            onClick={() => onPick(color)}
            className="h-6 w-6 rounded-full border-2 border-transparent transition-transform hover:scale-125 hover:border-white"
            style={{ background: swatch }}
          />
        ))
      )}
    </div>
  );
}
