"use client";

import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { HighlightColor, HighlightRow, HighlightWithThread, ThreadRow } from "@/lib/types";

export interface UseHighlights {
  highlights: HighlightWithThread[];
  setHighlights: Dispatch<SetStateAction<HighlightWithThread[]>>;
  create: (start: number, end: number, color: HighlightColor) => Promise<HighlightWithThread>;
  remove: (highlightId: string) => Promise<void>;
  error: string | null;
  clearError: () => void;
}

export function useHighlights(documentId: string, initial: HighlightWithThread[]): UseHighlights {
  const [highlights, setHighlights] = useState<HighlightWithThread[]>(initial);
  const [error, setError] = useState<string | null>(null);

  const create = useCallback(
    async (start: number, end: number, color: HighlightColor) => {
      const res = await fetch("/api/highlights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, charStart: start, charEnd: end, color }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        const message = data?.error ?? "Could not create the highlight";
        setError(message);
        throw new Error(message);
      }
      const { highlight, thread } = (await res.json()) as {
        highlight: HighlightRow;
        thread: ThreadRow;
      };
      const item: HighlightWithThread = { ...highlight, thread: { ...thread, messages: [] } };
      setHighlights((prev) =>
        [...prev, item].sort((a, b) => a.char_start - b.char_start),
      );
      return item;
    },
    [documentId],
  );

  const remove = useCallback(async (highlightId: string) => {
    setHighlights((prev) => prev.filter((h) => h.id !== highlightId));
    const res = await fetch(`/api/highlights/${highlightId}`, { method: "DELETE" });
    if (!res.ok) setError("Could not delete the highlight");
  }, []);

  return { highlights, setHighlights, create, remove, error, clearError: () => setError(null) };
}
