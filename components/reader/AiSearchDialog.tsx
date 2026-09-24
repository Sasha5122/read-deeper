"use client";

import { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";

interface AiSearchDialogProps {
  open: boolean;
  onClose: () => void;
  documentId: string;
  onGoToPage: (pageNo: number) => void;
  /**
   * Jump to the exact zone of a finding: the verbatim «quote» locates the
   * spot on the page. When missing, finding rows fall back to onGoToPage.
   */
  onJumpToQuote?: (quote: string, page: number) => void;
  /** Real page count of the document; without it we read "of N" from the header. */
  pageCount?: number;
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

/* ------------------------------------------------------ citation parsing */

/** One page number or an N–M range with -, – or — as separator. */
const PAGE_ITEM = String.raw`\d{1,5}(?:\s*[-–—]\s*\d{1,5})?`;
/** A comma-separated list of items: "3", "303–304", "3, 5, 10-12". */
const PAGE_LIST = String.raw`${PAGE_ITEM}(?:\s*,\s*${PAGE_ITEM})*`;

/** Cap when expanding one N–M range into individual pages. */
const RANGE_EXPANSION_CAP = 10;

/**
 * Every distinct page an answer cites, deduped + sorted ascending. Catches:
 * (p. N) · (pp. N–M) with -, – or — · (p. N, M) · bare "p. N" / "pp. N-M"
 * outside parens · "page N" / "pages N-M". Ranges expand into individual
 * pages (capped at 10 per range).
 */
export function parseCitedPages(answer: string): number[] {
  const patterns = [
    // Parenthesised: (p. 12) (pp. 303–304) (p 3, 5) (pag. 12) — dot optional.
    new RegExp(String.raw`\(\s*(?:pp?|pag)\.?\s*(${PAGE_LIST})\s*\)`, "gi"),
    // Bare, dot required so plain prose "p 5" doesn't trigger: p. 12 / pp. 12-14
    new RegExp(String.raw`\bpp?\.\s*(${PAGE_LIST})`, "gi"),
    // Words: page 7, pages 10–12
    new RegExp(String.raw`\bpages?\s+(${PAGE_LIST})`, "gi"),
  ];
  const found = new Set<number>();
  for (const re of patterns) {
    for (const match of answer.matchAll(re)) {
      for (const item of match[1].split(",")) {
        const nums = item.match(/\d+/g);
        if (!nums) continue;
        const from = Number(nums[0]);
        if (!Number.isInteger(from) || from < 1) continue;
        const to = nums.length > 1 ? Number(nums[1]) : from;
        const end = to >= from ? Math.min(to, from + RANGE_EXPANSION_CAP - 1) : from;
        for (let p = from; p <= end; p++) found.add(p);
      }
    }
  }
  return Array.from(found).sort((a, b) => a - b);
}

/* ------------------------------------------------------- finding parsing */

/** A verbatim document quote in guillemets: «exact words». */
const QUOTE_RE = /«([^«»]+)»/;

export interface ParsedFinding {
  quote: string;
  page: number;
}

/**
 * A line is a clickable FINDING when it carries a «verbatim quote» AND a page
 * citation. The page is taken from the text AFTER the closing » when possible
 * (the prompt mandates «quote» (p. N) tails), falling back to any citation on
 * the line; the lowest cited page wins when several are listed.
 */
export function parseFinding(line: string): ParsedFinding | null {
  const q = QUOTE_RE.exec(line);
  if (!q) return null;
  const quote = q[1].trim();
  if (!quote) return null;
  const tail = line.slice((q.index ?? 0) + q[0].length);
  const pages = parseCitedPages(tail);
  const page = pages[0] ?? parseCitedPages(line)[0];
  if (page == null) return null;
  return { quote, page };
}

type AnswerBlock =
  | { kind: "md"; text: string }
  | { kind: "finding"; text: string; quote: string; page: number };

/**
 * Split the (possibly still streaming) answer into markdown blocks and
 * finding lines. A partially streamed finding has no closing » or citation
 * yet, so it renders as plain markdown until complete — no flicker of dead
 * rows mid-stream.
 */
export function splitAnswerBlocks(answer: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length > 0) {
      blocks.push({ kind: "md", text: buf.join("\n") });
      buf = [];
    }
  };
  for (const line of answer.split("\n")) {
    const finding = parseFinding(line);
    if (finding) {
      flush();
      blocks.push({ kind: "finding", text: line, quote: finding.quote, page: finding.page });
    } else {
      buf.push(line);
    }
  }
  flush();
  return blocks;
}

/** Fallback when no pageCount prop: the reader header shows "of N". */
function readPageCountFromDom(): number | null {
  try {
    const input = document.querySelector('input[aria-label="Go to page"]');
    const sibling = input?.nextElementSibling?.textContent ?? "";
    let m = /of\s+(\d+)/.exec(sibling);
    if (!m) {
      for (const span of Array.from(document.querySelectorAll("span"))) {
        const t = span.textContent?.trim() ?? "";
        const mm = /^of\s+(\d+)$/.exec(t);
        if (mm) {
          m = mm;
          break;
        }
      }
    }
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Semantic search: the reader describes what they are looking for in their
 * own words; the model answers with page citations, each rendered as a jump
 * button. NON-MODAL by design: docked fixed over the right margin column so
 * the reader can scroll and read the document WHILE the results stay open —
 * outside clicks and page jumps do NOT close it, only ✕ or Escape do.
 */
export function AiSearchDialog({
  open,
  onClose,
  documentId,
  onGoToPage,
  onJumpToQuote,
  pageCount,
}: AiSearchDialogProps) {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fromCache, setFromCache] = useState(false);
  const [domPageCount, setDomPageCount] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) {
      setError("");
      setBusy(false);
      if (pageCount == null) setDomPageCount(readPageCountFromDom());
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
  }, [open, documentId, pageCount]);

  // No backdrop to catch keys anymore — Escape closes from anywhere.
  // Esc convention (one layer per press): every window Esc handler marks the
  // event as handled and skips already-handled events — otherwise this
  // handler AND the capture/card handlers both fire on the same keypress.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent & { rdEscHandled?: boolean }) => {
      if (e.key !== "Escape" || e.rdEscHandled) return;
      e.rdEscHandled = true;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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

  const totalPages = pageCount ?? domPageCount;
  const citedPages = parseCitedPages(answer);
  const answerBlocks = splitAnswerBlocks(answer);

  /** Finding rows jump to the exact zone; without the prop, to the page. */
  function jumpToFinding(quote: string, page: number) {
    if (onJumpToQuote) onJumpToQuote(quote, page);
    else onGoToPage(page);
  }

  return (
    <div
      role="dialog"
      aria-label="Find by meaning"
      data-testid="aisearch-dialog"
      className="fixed right-4 top-16 z-50 flex max-h-[calc(100vh-96px)] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-neutral-300 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06),0_18px_50px_rgba(0,0,0,0.18)]"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-4 py-2.5">
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

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
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
          {(answer || query) && !busy && (
            <button
              onClick={() => {
                clearCachedSearch(documentId);
                setQuery("");
                setAnswer("");
                setError("");
                setFromCache(false);
                inputRef.current?.focus({ preventScroll: true });
              }}
              aria-label="Clear and start a new search"
              data-testid="aisearch-new"
              title="Clear the question and results to start fresh"
              className="flex items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-semibold text-neutral-700 transition-colors hover:border-neutral-500 hover:bg-neutral-100"
            >
              <span aria-hidden className="text-[13px] leading-none">✕</span>
              New search
            </button>
          )}
          {busy ? (
            <button
              onClick={() => abortRef.current?.abort()}
              aria-label="Stop search"
              data-testid="aisearch-stop"
              title="Stop the search — whatever was found so far stays"
              className="flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-black"
            >
              <span aria-hidden className="block h-2.5 w-2.5 rounded-[2px] bg-white" />
              Stop
            </button>
          ) : (
            <button
              onClick={() => void ask()}
              disabled={query.trim().length === 0}
              className="rounded-lg bg-neutral-900 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-black disabled:bg-neutral-300"
            >
              Find
            </button>
          )}
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-[13px] text-red-700">
            {error}
          </div>
        )}

        {(answer || busy) && !error && (
          <div
            data-testid={fromCache ? "aisearch-cached-result" : undefined}
            className="mt-3 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-[13px] leading-relaxed text-neutral-800"
          >
            {answer ? (
              answerBlocks.map((block, i) =>
                block.kind === "finding" ? (
                  <div
                    key={i}
                    role="button"
                    tabIndex={0}
                    data-testid="aisearch-finding"
                    title={`Jump to «${block.quote}» on p. ${block.page}`}
                    onClick={() => jumpToFinding(block.quote, block.page)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        jumpToFinding(block.quote, block.page);
                      }
                    }}
                    className="-mx-1.5 cursor-pointer rounded-md px-1.5 py-0.5 transition-colors hover:bg-neutral-200/70 focus-visible:bg-neutral-200/70 focus-visible:outline-none"
                  >
                    <Markdown text={block.text} />
                  </div>
                ) : (
                  <Markdown key={i} text={block.text} />
                ),
              )
            ) : (
              // Live "searching" indicator: same animation pattern as the
              // thread cards' Thinking state; gone at the first token.
              <div
                data-testid="search-thinking"
                className="rd-thinking flex items-center gap-1.5 text-[12px]"
              >
                <span className="rd-thinking-word">Searching the document</span>
                <span className="rd-thinking-dots" aria-hidden="true">
                  <span className="rd-thinking-dot" />
                  <span className="rd-thinking-dot" />
                  <span className="rd-thinking-dot" />
                </span>
              </div>
            )}
            {busy && answer && <span className="animate-pulse"> ▍</span>}
          </div>
        )}

        {citedPages.length > 0 && !busy && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-neutral-400">Jump to:</span>
            {citedPages.map((p) => {
              const invalid = totalPages != null && p > totalPages;
              return (
                <button
                  key={p}
                  data-testid="aisearch-jump"
                  disabled={invalid}
                  title={invalid ? "Page doesn't exist" : `Go to page ${p}`}
                  onClick={() => {
                    // The dialog is non-modal: jump scrolls the document while
                    // the results stay open for the next jump.
                    if (!invalid) onGoToPage(p);
                  }}
                  className={
                    invalid
                      ? "cursor-not-allowed rounded-md border border-neutral-200 px-2 py-0.5 text-[11px] font-medium text-neutral-400 opacity-50"
                      : "rounded-md border border-neutral-300 px-2 py-0.5 text-[11px] font-medium text-neutral-700 transition-colors hover:border-neutral-800 hover:text-black"
                  }
                >
                  p. {p}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
