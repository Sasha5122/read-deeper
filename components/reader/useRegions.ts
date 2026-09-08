"use client";

import { useCallback, useState } from "react";
import type { HighlightColor, RegionRow, RegionWithThread, ThreadRow } from "@/lib/types";

export interface CreateRegionInput {
  pageNo: number;
  x: number;
  y: number;
  w: number;
  h: number;
  color: HighlightColor;
  /** PNG data URL — the captured pixels. */
  image: string;
}

export function useRegions(documentId: string, initial: RegionWithThread[]) {
  const [regions, setRegions] = useState<RegionWithThread[]>(initial);
  const [error, setError] = useState<string | null>(null);

  const createRegion = useCallback(
    async (input: CreateRegionInput): Promise<RegionWithThread> => {
      const res = await fetch("/api/regions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, ...input }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        const message = data?.error ?? "Could not save the capture";
        setError(message);
        throw new Error(message);
      }
      const { region, thread } = (await res.json()) as { region: RegionRow; thread: ThreadRow };
      const item: RegionWithThread = { ...region, thread: { ...thread, messages: [] } };
      setRegions((prev) => [...prev, item]);
      return item;
    },
    [documentId],
  );

  const removeRegion = useCallback(async (regionId: string) => {
    setRegions((prev) => prev.filter((r) => r.id !== regionId));
    const res = await fetch(`/api/regions/${regionId}`, { method: "DELETE" });
    if (!res.ok) setError("Could not delete the capture");
  }, []);

  return { regions, setRegions, createRegion, removeRegion, regionsError: error };
}
