"use client";

import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { HighlightWithThread, MessageRow, RegionWithThread, Role } from "@/lib/types";

export type ThreadInput = { content: string } | { action: "explain_simpler" | "give_example" };

export interface UseThreads {
  /** Thread id currently receiving a streamed answer, if any. */
  streamingThreadId: string | null;
  /** Partial assistant text for the streaming thread. */
  streamingText: string;
  send: (threadId: string, input: ThreadInput, questionShown: string) => Promise<void>;
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
      const apply = <T extends { thread: { id: string; title: string | null; messages: MessageRow[] } | null }>(
        prev: T[],
      ): T[] =>
        prev.map((h) =>
          h.thread?.id === threadId
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

  const send = useCallback(
    async (threadId: string, input: ThreadInput, questionShown: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setError(null);
      appendMessage(threadId, tempMessage(threadId, "user", questionShown), questionShown.slice(0, 80));
      setStreamingThreadId(threadId);
      setStreamingText("");

      try {
        const res = await fetch(`/api/threads/${threadId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!res.ok || !res.body) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? `Request failed (${res.status})`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let full = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          full += decoder.decode(value, { stream: true });
          setStreamingText(full);
        }
        full += decoder.decode();
        appendMessage(threadId, tempMessage(threadId, "assistant", full));
      } catch (err) {
        setError(err instanceof Error ? err.message : "The answer failed to stream");
      } finally {
        setStreamingThreadId(null);
        setStreamingText("");
        busyRef.current = false;
      }
    },
    [appendMessage],
  );

  const sendNote = useCallback(
    async (threadId: string, content: string) => {
      appendMessage(threadId, tempMessage(threadId, "user", content), content.slice(0, 80));
      const res = await fetch(`/api/threads/${threadId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, noteOnly: true }),
      });
      if (!res.ok) setError("Could not save the note");
    },
    [appendMessage],
  );

  return { streamingThreadId, streamingText, send, sendNote, error, clearError: () => setError(null) };
}
