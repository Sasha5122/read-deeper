"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** How long the reader can change their mind before the DELETE fires. */
export const UNDO_WINDOW_MS = 6000;

interface PendingDelete {
  /** Highlight or region id — drives the toast (keyed remount per delete). */
  id: string;
  /** Existing DELETE endpoint, e.g. /api/highlights/<id>. */
  url: string;
  /** Puts the stashed item back into the UI state it came from. */
  restore: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface UseUndoDelete {
  /** Id of the item whose server delete is pending (null = no toast). */
  pendingId: string | null;
  /**
   * Start a delayed delete. The caller has ALREADY removed the item from UI
   * state (optimistic, same visual result as before); the server DELETE fires
   * only after UNDO_WINDOW_MS. One pending delete at a time: scheduling a
   * second one flushes the first immediately.
   */
  scheduleDelete: (opts: { id: string; url: string; restore: () => void }) => void;
  /** Cancel the pending server delete and restore the item into the UI. */
  undo: () => void;
}

/**
 * Delayed delete with undo — nothing touches the server until the window
 * elapses, so "Undo" is purely a client-side state restore (no migration, no
 * new endpoints). Used by Reader for both highlight-thread and region-thread ✕.
 */
export function useUndoDelete(): UseUndoDelete {
  const pendingRef = useRef<PendingDelete | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const fire = useCallback((url: string, keepalive = false) => {
    try {
      void fetch(url, { method: "DELETE", keepalive }).catch(() => {});
    } catch {
      // Best effort — the row survives at worst, never the other way round.
    }
  }, []);

  /** Fire the pending delete NOW (second delete arrived / page is leaving). */
  const flush = useCallback(
    (keepalive = false) => {
      const p = pendingRef.current;
      if (!p) return;
      clearTimeout(p.timer);
      pendingRef.current = null;
      setPendingId(null);
      fire(p.url, keepalive);
    },
    [fire],
  );

  const scheduleDelete = useCallback(
    ({ id, url, restore }: { id: string; url: string; restore: () => void }) => {
      flush(); // one pending undo at a time — simple and predictable
      const timer = setTimeout(() => {
        pendingRef.current = null;
        setPendingId(null);
        fire(url);
      }, UNDO_WINDOW_MS);
      pendingRef.current = { id, url, restore, timer };
      setPendingId(id);
    },
    [flush, fire],
  );

  const undo = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingRef.current = null;
    setPendingId(null);
    p.restore();
  }, []);

  // Page unload with a pending delete: fire it best-effort so it isn't lost.
  // sendBeacon can't send DELETE, so keepalive fetch is the beacon here; the
  // unmount cleanup covers client-side navigation away from the reader.
  useEffect(() => {
    const onLeave = () => flush(true);
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
      onLeave();
    };
  }, [flush]);

  return { pendingId, scheduleDelete, undo };
}
