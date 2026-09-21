"use client";

import { useEffect, useRef, useState } from "react";
import type { HighlightWithThread } from "@/lib/types";
import { Markdown } from "./Markdown";
import { stopStreaming, type ThreadInput } from "./useThreads";

const DOT_COLORS: Record<string, string> = {
  amber: "#e0b446",
  green: "#5f9e5f",
  blue: "#5f83ac",
  rose: "#c06a76",
};

interface ThreadCardProps {
  highlight: HighlightWithThread;
  expanded: boolean;
  streamingText: string | null;
  busy: boolean;
  onActivate: () => void;
  onCollapse: () => void;
  onSend: (input: ThreadInput, questionShown: string) => void;
  /** Persist the reader's own text as a note — no AI. */
  onSaveNote: (content: string) => void;
  onDelete: () => void;
  /** Bottom-sheet mode renders without absolute positioning. */
  asSheet?: boolean;
  style?: React.CSSProperties;
}

export function ThreadCard({
  highlight,
  expanded,
  streamingText,
  busy,
  onActivate,
  onCollapse,
  onSend,
  onSaveNote,
  onDelete,
  asSheet = false,
  style,
}: ThreadCardProps) {
  const thread = highlight.thread;
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // preventScroll: the card may not be positioned yet on its first frame —
    // a plain focus() would yank the reader's scroll to the top.
    if (expanded) inputRef.current?.focus({ preventScroll: true });
  }, [expanded]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [streamingText, thread?.messages.length, expanded]);

  if (!thread) return null;

  function saveNote() {
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    onSaveNote(content);
  }

  function askAi() {
    const content = draft.trim();
    if (!content || busy) return;
    setDraft("");
    onSend({ content }, content);
  }

  if (!expanded) {
    return (
      <button
        data-card={highlight.id}
        onClick={onActivate}
        style={style}
        className={`flex items-center gap-2.5 rounded-lg border border-neutral-300 bg-white py-2 pl-3 pr-3.5 text-left text-xs shadow-[0_1px_2px_rgba(0,0,0,0.05)] transition-[border-color,box-shadow] hover:border-neutral-400 hover:shadow-[0_2px_8px_rgba(0,0,0,0.07)] ${asSheet ? "" : "absolute left-6 max-w-[calc(100%-2.25rem)]"}`}
        title={thread.title ?? "Open thread"}
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: DOT_COLORS[highlight.color] }}
        />
        {thread.title && (
          <span className="truncate font-medium text-neutral-600">{thread.title}</span>
        )}
      </button>
    );
  }

  return (
    <div
      data-card={highlight.id}
      style={style}
      className={`flex flex-col overflow-hidden rounded-xl border border-neutral-300 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06),0_10px_28px_rgba(0,0,0,0.09)] ${asSheet ? "max-h-[75vh]" : "absolute left-6 right-3"}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCollapse();
      }}
    >
      <div className="flex items-center gap-2.5 border-b border-neutral-200 px-3.5 py-2.5">
        <span
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ background: DOT_COLORS[highlight.color] }}
        />
        <span className="flex-1" />
        <button
          onClick={onDelete}
          aria-label="Delete highlight and thread"
          className="grid h-6 w-6 place-items-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-800"
          title="Delete highlight and thread"
        >
          ✕
        </button>
      </div>

      <div
        ref={scrollRef}
        className="flex max-h-[46vh] min-h-[3.5rem] flex-col gap-1.5 overflow-y-auto px-3 py-2.5"
      >
        {thread.messages.map((m) =>
          m.role === "user" ? (
            <div
              key={m.id}
              className="max-w-[88%] self-end whitespace-pre-wrap rounded-lg rounded-br-sm bg-neutral-100 px-2.5 py-1.5 text-[13px] leading-[1.45] text-neutral-800"
            >
              {m.content}
            </div>
          ) : (
            <div key={m.id} className="text-[13px] leading-[1.45] text-neutral-800">
              <Markdown text={m.content} />
            </div>
          ),
        )}
        {streamingText !== null &&
          (streamingText === "" ? (
            <div
              data-testid="thinking-indicator"
              className="rd-thinking flex items-center gap-1.5 text-[12px]"
            >
              <span className="rd-thinking-word">Thinking</span>
              <span className="rd-thinking-dots" aria-hidden="true">
                <span className="rd-thinking-dot" />
                <span className="rd-thinking-dot" />
                <span className="rd-thinking-dot" />
              </span>
            </div>
          ) : (
            <div className="text-[13px] leading-[1.45] text-neutral-800">
              <Markdown text={streamingText} />
              <span className="ml-0.5 inline-block h-3.5 w-1 animate-pulse rounded-sm bg-neutral-700 align-text-bottom" />
            </div>
          ))}
      </div>

      {/* Conversation starters — only while the thread is still empty; once
          the dialogue begins they disappear (the reader just types). */}
      {thread.messages.length === 0 && streamingText === null && (
        <div className="flex flex-wrap gap-1.5 px-3.5 pb-1 pt-0.5">
          <button
            onClick={() => onSend({ action: "explain_simpler" }, "Explain")}
            disabled={busy}
            className="rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-600 transition-colors hover:border-neutral-800 hover:bg-neutral-900 hover:text-white disabled:opacity-50"
          >
            Explain
          </button>
          <button
            onClick={() => onSend({ action: "give_example" }, "Explain with example")}
            disabled={busy}
            className="rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-600 transition-colors hover:border-neutral-800 hover:bg-neutral-900 hover:text-white disabled:opacity-50"
          >
            Explain with example
          </button>
          <button
            onClick={saveNote}
            disabled={draft.trim().length === 0}
            title="Keep what you typed as your personal note — no AI"
            className="rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-600 transition-colors hover:border-neutral-800 hover:bg-neutral-900 hover:text-white disabled:opacity-50"
          >
            Note
          </button>
        </div>
      )}

      <div className="flex items-end gap-2 border-t border-neutral-200 p-3">
        <textarea
          ref={inputRef}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              // Enter asks AI; a note is saved only via the Note button.
              e.preventDefault();
              askAi();
            }
          }}
          placeholder="Ask AI — or press Note to keep it for yourself…"
          className="max-h-36 min-h-[2.75rem] flex-1 resize-none rounded-lg border border-neutral-300 bg-neutral-50 px-2.5 py-1.5 text-[13px] text-neutral-800 outline-none transition-[border-color,background-color] placeholder:text-neutral-400 focus:border-neutral-500 focus:bg-white"
        />
        {streamingText !== null ? (
          /* This thread is generating — square-in-circle Stop replaces Send.
             stopStreaming aborts the fetch; everything streamed so far stays. */
          <button
            onClick={stopStreaming}
            aria-label="Stop generating"
            title="Stop generating"
            className="grid h-7 w-10 shrink-0 place-items-center self-end rounded-md border border-neutral-900 bg-white text-neutral-900 transition-colors hover:bg-neutral-100"
          >
            <span className="grid h-4 w-4 place-items-center rounded-full border-[1.5px] border-current">
              <span className="h-1.5 w-1.5 rounded-[1px] bg-current" />
            </span>
          </button>
        ) : (
          <button
            onClick={askAi}
            disabled={busy || draft.trim().length === 0}
            aria-label="Ask AI"
            title="Ask AI (Enter)"
            className="grid h-7 w-10 shrink-0 place-items-center self-end rounded-md bg-neutral-900 text-sm text-white transition-colors hover:bg-black disabled:bg-neutral-300"
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
}
