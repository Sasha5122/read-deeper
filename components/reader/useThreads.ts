"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { HighlightWithThread, MessageRow, RegionWithThread, Role } from "@/lib/types";

export type ThreadInput = { content: string } | { action: "explain_simpler" | "give_example" };

export interface UseThreads {
  /** Thread id currently receiving a streamed answer, if any. */
  streamingThreadId: string | null;
  /** Partial assistant text for the streaming thread (display-paced). */
  streamingText: string;
  send: (threadId: string, input: ThreadInput, questionShown: string) => Promise<void>;
  /** Abort the in-flight answer; everything streamed so far is kept. */
  stop: () => void;
  /** Persist a private note on the thread — no AI call. */
  sendNote: (threadId: string, content: string) => Promise<void>;
  error: string | null;
  clearError: () => void;
}

let tempCounter = 0;
function tempMessage(threadId: string, role: Role, content: string): MessageRow {
  return {
    id: `tmp-${Date.now()}-${tempCounter++}`,
    thread_id: threadId,
    role,
    content,
    tokens_in: null,
    tokens_out: null,
    created_at: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ stop --
 * One answer streams at a time (busyRef gate), so the active stream's stop
 * handle lives at module level: ThreadCard's Stop button calls stopStreaming()
 * directly — Reader.tsx needs no new plumbing. */
let activeStop: (() => void) | null = null;
/** Thread id of the in-flight answer (module-level twin of streamingThreadId). */
let activeThreadId: string | null = null;

/** Abort the currently streaming answer (no-op when nothing streams). */
export function stopStreaming(): void {
  activeStop?.();
}

/**
 * Abort the in-flight answer ONLY if it belongs to `threadId` — exactly like
 * the Stop button (fetch aborted, display buffer flushed, the server persists
 * the partial). Reader.tsx must call this in deleteItem before scheduling the
 * delayed delete (`stopIfStreaming(item.thread?.id)`), otherwise deleting the
 * streaming card leaves the stream orphaned: busy stays true for the whole
 * generation (every Send disabled, Stop button gone with the card).
 */
export function stopIfStreaming(threadId: string | null | undefined): void {
  if (threadId && threadId === activeThreadId) activeStop?.();
}

/* --------------------------------------------------- delete/undo safety net
 * Every message appended client-side is ALSO recorded here (a small rolling
 * registry per thread). Why: when a card is deleted while its answer streams,
 * the streamed text can no longer land in React state (the thread is gone),
 * so an Undo restore from useUndoDelete's snapshot would silently lose the
 * answer. useUndoDelete calls mergeRestoredThreadMessages() right after the
 * restore; the merge re-attaches any registry messages missing from the
 * restored thread. Dedup is by message id, so the merge is idempotent and a
 * no-op for threads that never lost anything. */
const REGISTRY_CAP_PER_THREAD = 10;
const REGISTRY_CAP_THREADS = 50;
const appendedRegistry = new Map<string, MessageRow[]>();
/** Set by the mounted useThreads instance (single reader per page). */
let mergeAllRegistered: (() => void) | null = null;

/** Re-attach registry messages to whatever threads exist in state (post-Undo). */
export function mergeRestoredThreadMessages(): void {
  mergeAllRegistered?.();
}

function recordAppend(threadId: string, message: MessageRow): void {
  const list = appendedRegistry.get(threadId) ?? [];
  appendedRegistry.set(
    threadId,
    [...list.filter((m) => m.id !== message.id), message].slice(-REGISTRY_CAP_PER_THREAD),
  );
  if (appendedRegistry.size > REGISTRY_CAP_THREADS) {
    const oldest = appendedRegistry.keys().next().value;
    if (oldest !== undefined && oldest !== threadId) appendedRegistry.delete(oldest);
  }
}

function dropFromRegistry(threadId: string, messageId: string): void {
  const list = appendedRegistry.get(threadId);
  if (list) appendedRegistry.set(threadId, list.filter((m) => m.id !== messageId));
}

/* ----------------------------------------------------------- display pacer
 * The model emits text in bursts after a long thinking pause — unreadable.
 * Network deltas land instantly in a hidden buffer; a timer REVEALS them at
 * reading speed. Display-only: the network read is never slowed, and Stop
 * flushes the whole buffer at once. */
const PACE_TICK_MS = 40;
const PACE_BASE_CPS = 75; // steady reveal speed, characters/second
const PACE_LAG_CHARS = 600; // backlog above this switches to catch-up…
const PACE_MAX_LAG_S = 5; // …fast enough to stay within ~5s of the wire
const PACE_LIVE_MAX_CPS = 150; // catch-up ceiling WHILE streaming (measured: unbounded backlog/5 hit 213 cps — too fast to read)
const PACE_ENDED_MULT = 4; // drain speed once the stream has ended (uncapped)
const PACE_WORD_CAP = 40; // longest run revealed while seeking whitespace

interface Pacer {
  /** A network delta arrived — buffer it (starts the reveal loop). */
  push(delta: string): void;
  /** Stream ended: drain at 3× speed, resolve with the full raw text. */
  end(): Promise<string>;
  /** Show everything received immediately (Stop); returns the full raw text. */
  flush(): string;
}

function createPacer(onReveal: (text: string) => void): Pacer {
  let raw = "";
  let shown = 0;
  let done = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastTs = 0;
  let onDrained: (() => void) | null = null;

  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  // Reveal in word/whitespace chunks: extend the cut to the next whitespace
  // (capped for pathological unbroken runs; never split a surrogate pair).
  const boundary = (target: number): number => {
    if (target >= raw.length) return raw.length;
    let i = target;
    while (i < raw.length && i - target < PACE_WORD_CAP && !/\s/.test(raw[i]!)) i++;
    if (i < raw.length && !/\s/.test(raw[i]!)) {
      const c = raw.charCodeAt(i - 1);
      if (c >= 0xd800 && c <= 0xdbff) i++; // keep the pair together
    }
    return i;
  };

  const tick = () => {
    const now = Date.now();
    // Background tabs clamp intervals — trust wall-clock dt, capped at 1s.
    const dt = lastTs ? Math.min((now - lastTs) / 1000, 1) : PACE_TICK_MS / 1000;
    lastTs = now;
    const backlog = raw.length - shown;
    if (backlog > 0) {
      let cps = PACE_BASE_CPS;
      if (done) cps = PACE_BASE_CPS * PACE_ENDED_MULT;
      else if (backlog > PACE_LAG_CHARS)
        cps = Math.min(Math.max(cps, backlog / PACE_MAX_LAG_S), PACE_LIVE_MAX_CPS);
      shown = boundary(Math.min(raw.length, shown + Math.max(1, Math.round(cps * dt))));
      onReveal(raw.slice(0, shown));
    }
    if (done && shown >= raw.length) {
      stopTimer();
      onDrained?.();
      onDrained = null;
    }
  };

  return {
    push(delta) {
      if (!delta) return;
      raw += delta;
      if (timer === null && !done) {
        lastTs = 0;
        timer = setInterval(tick, PACE_TICK_MS);
      }
    },
    end() {
      done = true;
      if (timer === null && shown >= raw.length) return Promise.resolve(raw);
      return new Promise((resolve) => {
        onDrained = () => resolve(raw);
      });
    },
    flush() {
      done = true;
      stopTimer();
      if (shown < raw.length) {
        shown = raw.length;
        onReveal(raw);
      }
      onDrained?.();
      onDrained = null;
      return raw;
    },
  };
}

export function useThreads(
  setHighlights: Dispatch<SetStateAction<HighlightWithThread[]>>,
  /** Region (capture) threads live in a separate list — messages must land there too. */
  setRegions?: Dispatch<SetStateAction<RegionWithThread[]>>,
): UseThreads {
  const [streamingThreadId, setStreamingThreadId] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const appendMessage = useCallback(
    (threadId: string, message: MessageRow, title?: string) => {
      recordAppend(threadId, message); // undo-restore safety net (see above)
      const apply = <T extends { thread: { id: string; title: string | null; messages: MessageRow[] } | null }>(
        prev: T[],
      ): T[] =>
        prev.map((h) =>
          // Dedup by id: the undo merge may already have re-attached this
          // message, and StrictMode can re-run updaters.
          h.thread?.id === threadId && !h.thread.messages.some((m) => m.id === message.id)
            ? {
                ...h,
                thread: {
                  ...h.thread,
                  title: h.thread.title ?? title ?? null,
                  messages: [...h.thread.messages, message],
                },
              }
            : h,
        );
      setHighlights(apply);
      setRegions?.(apply);
    },
    [setHighlights, setRegions],
  );

  /** Replace/remove messages of one thread in both lists (pending notes). */
  const mutateMessages = useCallback(
    (threadId: string, fn: (msgs: MessageRow[]) => MessageRow[]) => {
      const apply = <T extends { thread: { id: string; title: string | null; messages: MessageRow[] } | null }>(
        prev: T[],
      ): T[] =>
        prev.map((h) =>
          h.thread?.id === threadId
            ? { ...h, thread: { ...h.thread, messages: fn(h.thread.messages) } }
            : h,
        );
      setHighlights(apply);
      setRegions?.(apply);
    },
    [setHighlights, setRegions],
  );

  // Register the undo-merge for this (single) reader instance: append any
  // registry messages a restored thread is missing. Runs via
  // mergeRestoredThreadMessages() from useUndoDelete after an Undo restore.
  const mergeAll = useCallback(() => {
    const apply = <T extends { thread: { id: string; title: string | null; messages: MessageRow[] } | null }>(
      prev: T[],
    ): T[] =>
      prev.map((h) => {
        const extra = h.thread ? appendedRegistry.get(h.thread.id) : undefined;
        if (!h.thread || !extra || extra.length === 0) return h;
        const have = new Set(h.thread.messages.map((m) => m.id));
        const missing = extra.filter((m) => !have.has(m.id));
        return missing.length > 0
          ? { ...h, thread: { ...h.thread, messages: [...h.thread.messages, ...missing] } }
          : h;
      });
    setHighlights(apply);
    setRegions?.(apply);
  }, [setHighlights, setRegions]);
  useEffect(() => {
    mergeAllRegistered = mergeAll;
    return () => {
      if (mergeAllRegistered === mergeAll) mergeAllRegistered = null;
    };
  }, [mergeAll]);

  const send = useCallback(
    async (threadId: string, input: ThreadInput, questionShown: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setError(null);
      appendMessage(threadId, tempMessage(threadId, "user", questionShown), questionShown.slice(0, 80));
      setStreamingThreadId(threadId);
      setStreamingText("");

      const controller = new AbortController();
      const pacer = createPacer(setStreamingText);
      // Stop = abort the fetch (the server sees it on request.signal, aborts
      // the OpenAI stream and saves the partial) + flush the display buffer
      // so everything already received shows instantly.
      activeThreadId = threadId; // lets stopIfStreaming target this stream
      activeStop = () => {
        controller.abort();
        pacer.flush();
      };

      let finalText: string | null = null;
      try {
        const res = await fetch(`/api/threads/${threadId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? `Request failed (${res.status})`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pacer.push(decoder.decode(value, { stream: true }));
        }
        pacer.push(decoder.decode());
        finalText = await pacer.end();
      } catch (err) {
        if (controller.signal.aborted) {
          // Stopped by the reader: keep the partial — the server persisted
          // the same text, so it survives a reload too.
          finalText = pacer.flush();
        } else {
          // Mid-stream failure: KEEP what already streamed, exactly like the
          // Stop branch (discarding the flush wiped the partial off the card).
          finalText = pacer.flush();
          setError(
            finalText.length > 0
              ? "Connection interrupted — the partial answer was kept."
              : err instanceof Error
                ? err.message
                : "The answer failed to stream",
          );
        }
      } finally {
        activeStop = null;
        activeThreadId = null;
        if (finalText !== null && finalText.length > 0) {
          // Defensive: if the thread was deleted mid-stream, this append is a
          // state no-op (the map finds nothing — no crash), but the message
          // still lands in the registry, so an Undo restore recovers it via
          // mergeRestoredThreadMessages().
          appendMessage(threadId, tempMessage(threadId, "assistant", finalText));
        }
        setStreamingThreadId(null);
        setStreamingText("");
        busyRef.current = false; // always released, even if the thread is gone
      }
    },
    [appendMessage],
  );

  const sendNote = useCallback(
    async (threadId: string, content: string) => {
      // Optimistic but PENDING: the note renders dimmed (ThreadCard dims ids
      // starting with "pending-") until the server confirms; on failure it is
      // removed instead of lingering as a phantom. Never rejects — Reader
      // fire-and-forgets this call.
      const pending = tempMessage(threadId, "user", content);
      pending.id = `pending-${pending.id}`;
      appendMessage(threadId, pending, content.slice(0, 80));
      try {
        const res = await fetch(`/api/threads/${threadId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, noteOnly: true }),
        });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const data = (await res.json().catch(() => null)) as { message?: MessageRow } | null;
        // Solidify: swap the dimmed pending row for the confirmed server row
        // (fallback keeps the text with a non-pending temp id).
        const confirmed =
          data?.message ?? { ...pending, id: pending.id.slice("pending-".length) };
        mutateMessages(threadId, (msgs) =>
          msgs.map((m) => (m.id === pending.id ? confirmed : m)),
        );
        dropFromRegistry(threadId, pending.id);
        recordAppend(threadId, confirmed);
      } catch {
        mutateMessages(threadId, (msgs) => msgs.filter((m) => m.id !== pending.id));
        dropFromRegistry(threadId, pending.id);
        setError("Could not save the note");
      }
    },
    [appendMessage, mutateMessages],
  );

  return {
    streamingThreadId,
    streamingText,
    send,
    stop: stopStreaming,
    sendNote,
    error,
    clearError: () => setError(null),
  };
}
