"use client";

import { useEffect, useState } from "react";
import { UNDO_WINDOW_MS } from "./useUndoDelete";

/**
 * Small monochrome toast, bottom-center above the pan bar zone: "Conversation
 * deleted. — Undo". The thin strip underneath drains over the undo window
 * (width transition — no keyframes needed; Reader keys it by the pending id
 * so a second delete remounts it and restarts the countdown).
 */
export function UndoToast({ onUndo }: { onUndo: () => void }) {
  const [drained, setDrained] = useState(false);
  useEffect(() => {
    // Double rAF: the bar must paint at full width once before transitioning.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setDrained(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, []);

  return (
    <div
      data-testid="undo-toast"
      className="fixed bottom-9 left-1/2 z-40 -translate-x-1/2 overflow-hidden rounded-lg border border-neutral-300 bg-white shadow-[0_2px_6px_rgba(0,0,0,0.08),0_10px_28px_rgba(0,0,0,0.12)]"
    >
      <div className="flex items-center gap-2.5 px-3.5 py-2 text-[13px] text-neutral-800">
        <span>Conversation deleted.</span>
        <span aria-hidden="true" className="text-neutral-300">
          —
        </span>
        <button
          onClick={onUndo}
          aria-label="Undo delete"
          className="font-semibold text-neutral-900 underline underline-offset-2 transition-colors hover:text-black"
        >
          Undo
        </button>
      </div>
      <div className="h-[2px] bg-neutral-100">
        <div
          className="h-full bg-neutral-400"
          style={{
            width: drained ? "0%" : "100%",
            transition: `width ${UNDO_WINDOW_MS}ms linear`,
          }}
        />
      </div>
    </div>
  );
}
