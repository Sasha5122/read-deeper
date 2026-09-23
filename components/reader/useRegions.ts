"use client";

import { useCallback, useRef, useState } from "react";
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
  // The last payload whose save failed — the captured PNG is expensive to
  // reframe, so keep it for retryLastRegion() instead of losing it.
  const lastFailed = useRef<CreateRegionInput | null>(null);

  const createRegion = useCallback(
    async (input: CreateRegionInput): Promise<RegionWithThread> => {
      let res: Response;
      try {
        res = await fetch("/api/regions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documentId, ...input }),
        });
      } catch {
        // Network failure (offline, DNS, aborted) — keep the framed PNG so a
        // retry does not have to be re-captured.
        lastFailed.current = input;
        const message = "Couldn't save the capture — check your connection and try again.";
        setError(message);
        throw new Error(message);
      }
      if (!res.ok) {
        lastFailed.current = input;
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        const message = data?.error ?? "Couldn't save the capture — try again.";
        setError(message);
        throw new Error(message);
      }
      const { region, thread } = (await res.json()) as { region: RegionRow; thread: ThreadRow };
      lastFailed.current = null;
      const item: RegionWithThread = { ...region, thread: { ...thread, messages: [] } };
      setRegions((prev) => [...prev, item]);
      return item;
    },
    [documentId],
  );

  /** Re-attempt the last failed capture save. Resolves the created region, or null when there is nothing to retry / it failed again (error state is set). */
  const retryLastRegion = useCallback(async (): Promise<RegionWithThread | null> => {
    const payload = lastFailed.current;
    if (!payload) return null;
    setError(null);
    try {
      return await createRegion(payload);
    } catch {
      return null; // createRegion already set the error and kept the payload
    }
  }, [createRegion]);

  const removeRegion = useCallback(async (regionId: string) => {
    setRegions((prev) => prev.filter((r) => r.id !== regionId));
    try {
      const res = await fetch(`/api/regions/${regionId}`, { method: "DELETE" });
      if (!res.ok) setError("Could not delete the capture");
    } catch {
      setError("Couldn't delete the capture — check your connection and try again.");
    }
  }, []);

  const clearRegionsError = useCallback(() => setError(null), []);

  return {
    regions,
    setRegions,
    createRegion,
    removeRegion,
    regionsError: error,
    clearRegionsError,
    retryLastRegion,
  };
}
