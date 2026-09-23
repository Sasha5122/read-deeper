"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mergeRestoredThreadMessages } from "./useThreads";

/** How long the reader can change their mind before the DELETE fires. */
export const UNDO_WINDOW_MS = 6000;
/**
 * The server DELETE fires this much AFTER the toast's visual countdown ends
 * (UndoToast animates over UNDO_WINDOW_MS). While the toast is mounted its
 * Undo button therefore always still has a live pending delete behind it —
 * no visible-but-dead click at the window edge.
 */
export const UNDO_GRACE_MS = 300;

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
  /** Ids whose DELETE already fired — a second fast ✕ must not re-schedule. */
  const firedRef = useRef<Set<string>>(new Set());

  const fire = useCallback((id: string, url: string, keepalive = false) => {
    firedRef.current.add(id);
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
      fire(p.id, p.url, keepalive);
    },
    [fire],
  );

  const scheduleDelete = useCallback(
    ({ id, url, restore }: { id: string; url: string; restore: () => void }) => {
      // Double-click guard: the same id already pending (or already fired)
      // must not schedule a second DELETE that would 404 later.
      if (pendingRef.current?.id === id || firedRef.current.has(id)) return;
      flush(); // one pending undo at a time — simple and predictable
      // The timer runs UNDO_GRACE_MS past the toast's visual countdown so an
      // Undo click on a still-visible toast always finds the pending delete.
      const timer = setTimeout(() => {
        pendingRef.current = null;
        setPendingId(null);
        fire(id, url);
      }, UNDO_WINDOW_MS + UNDO_GRACE_MS);
      pendingRef.current = { id, url, restore, timer };
      setPendingId(id);
    },
    [flush, fire],
  );

  const undo = useCallback(() => {
    const p = pendingRef.current;
    if (!p) {
      // Undo arrived just past the flush boundary: too late to cancel, but
      // never leave a visible-but-dead toast — hide it immediately.
      setPendingId(null);
      return;
    }
    clearTimeout(p.timer);
    pendingRef.current = null;
    setPendingId(null);
    p.restore();
    // The restore() snapshot was taken at delete time; anything streamed into
    // the thread since (delete-during-answer) lives only in useThreads'
    // append registry — re-attach it so Undo brings the answer back too.
    mergeRestoredThreadMessages();
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
