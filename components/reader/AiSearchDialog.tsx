"use client";

import { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";

interface AiSearchDialogProps {
  open: boolean;
  onClose: () => void;
  documentId: string;
  onGoToPage: (pageNo: number) => void;
}

/**
 * Last finished (or partially streamed) result per document, so closing the
 * dialog — e.g. via a page-jump button — never throws the answer away. The
 * module Map survives dialog close/unmount within the SPA session; the
 * sessionStorage mirror survives a page reload in the same tab.
 */
type CachedSearch = { question: string; answer: string; done: boolean };

const searchCache = new Map<string, CachedSearch>();

const storageKey = (documentId: string) => `rd-aisearch-${documentId}`;

function loadCachedSearch(documentId: string): CachedSearch | null {
  const inMemory = searchCache.get(documentId);
  if (inMemory) return inMemory;
  try {
    const raw = sessionStorage.getItem(storageKey(documentId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedSearch> | null;
    if (!parsed || typeof parsed.question !== "string" || typeof parsed.answer !== "string") {
      return null;
    }
    const entry: CachedSearch = { question: parsed.question, answer: parsed.answer, done: true };
    searchCache.set(documentId, entry);
    return entry;
  } catch {
    return null;
  }
}

function saveCachedSearch(documentId: string, entry: CachedSearch) {
  searchCache.set(documentId, entry);
  try {
    sessionStorage.setItem(storageKey(documentId), JSON.stringify(entry));
  } catch {
    // storage unavailable (private mode etc.) — in-memory cache still works
  }
}

function clearCachedSearch(documentId: string) {
  searchCache.delete(documentId);
  try {
    sessionStorage.removeItem(storageKey(documentId));
  } catch {
    // ignore
  }
}

/**
 * Semantic search: the reader describes what they are looking for in their
 * own words; retrieval (embeddings) + the strong model answer with page
 * citations, each rendered as a jump button.
 */
export function AiSearchDialog({ open, onClose, documentId, onGoToPage }: AiSearchDialogProps) {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fromCache, setFromCache] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) {
      setError("");
      setBusy(false);
      const cached = loadCachedSearch(documentId);
      if (cached && cached.answer) {
        // Restore the previous question + answer so a jump that landed in the
        // wrong place never costs a second AI call.
        setQuery(cached.question);
        setAnswer(cached.answer);
        setFromCache(true);
      } else {
        setAnswer("");
        setFromCache(false);
      }
      inputRef.current?.focus({ preventScroll: true });
    } else {
      abortRef.current?.abort();
    }
  }, [open, documentId]);

  if (!open) return null;

  async function ask() {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setAnswer("");
    setError("");
    setFromCache(false);
    const ac = new AbortController();
    abortRef.current = ac;
    let full = "";
    try {
      const res = await fetch("/api/document-ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, question: q }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `Search failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
        setAnswer(full);
        searchCache.set(documentId, { question: q, answer: full, done: false });
      }
      full += decoder.decode();
      setAnswer(full);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "Search failed");
      }
    } finally {
      // Preserve whatever streamed — including a partial answer if the dialog
      // was closed mid-stream (the close aborts the fetch, which lands here).
      if (full.trim()) saveCachedSearch(documentId, { question: q, answer: full, done: true });
      setBusy(false);
    }
  }

  const citedPages = Array.from(
    new Set(Array.from(answer.matchAll(/\(p\.\s*(\d+)(?:\s*[-–]\s*\d+)?\)/g), (m) => Number(m[1]))),
  ).slice(0, 8);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[14vh]"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Find by meaning"
        className="w-[min(34rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-neutral-300 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06),0_18px_50px_rgba(0,0,0,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-2.5">
          <span className="text-sm">✦</span>
          <span className="flex-1 text-xs font-semibold uppercase tracking-wider text-neutral-500">
            Find by meaning
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-6 w-6 place-items-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-800"
          >
            ✕
          </button>
        </div>

        <div className="p-4">
          <textarea
            ref={inputRef}
            rows={2}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask();
              }
            }}
            placeholder="Describe the place you're looking for, in your own words — e.g. “where he talks about losing his parents”"
            className="w-full resize-none rounded-lg border border-neutral-300 bg-neutral-50 px-3 py-2 text-[13px] text-neutral-800 outline-none transition-[border-color,background-color] placeholder:text-neutral-400 focus:border-neutral-500 focus:bg-white"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <span className="mr-auto text-[11px] text-neutral-400">
              Searches by context, not exact words
            </span>
            {answer && !busy && (
              <button
                onClick={() => {
                  clearCachedSearch(documentId);
                  setQuery("");
                  setAnswer("");
                  setError("");
                  setFromCache(false);
                  inputRef.current?.focus({ preventScroll: true });
                }}
                className="rounded-lg px-2 py-1.5 text-[11px] font-medium text-neutral-400 transition-colors hover:text-neutral-800"
              >
                New search
              </button>
            )}
            <button
              onClick={() => void ask()}
              disabled={query.trim().length === 0 || busy}
              className="rounded-lg bg-neutral-900 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-black disabled:bg-neutral-300"
            >
              {busy ? "Searching…" : "Find"}
            </button>
          </div>

          {error && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-[13px] text-red-700">
              {error}
            </div>
          )}

          {(answer || busy) && !error && (
            <div
              data-testid={fromCache ? "aisearch-cached-result" : undefined}
              className="mt-3 max-h-[44vh] overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-[13px] leading-relaxed text-neutral-800"
            >
              {answer ? <Markdown text={answer} /> : "Reading the document…"}
              {busy && answer && <span className="animate-pulse"> ▍</span>}
            </div>
          )}

          {citedPages.length > 0 && !busy && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-neutral-400">Jump to:</span>
              {citedPages.map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    onGoToPage(p);
                    onClose();
                  }}
                  className="rounded-md border border-neutral-300 px-2 py-0.5 text-[11px] font-medium text-neutral-700 transition-colors hover:border-neutral-800 hover:text-black"
                >
                  p. {p}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
