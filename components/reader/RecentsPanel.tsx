"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  UPLOAD_ACCEPT,
  UploadProgress,
  UploadToast,
  setUploadDialogOpen,
  useUploadDocument,
} from "@/components/upload/useUploadDocument";
import { MAX_UPLOAD_MB } from "@/lib/upload-limits";
import type { Plan } from "@/lib/types";

interface RecentSession {
  documentId: string;
  title: string;
  author: string | null;
  status: string;
  kind: string;
  /** True when the document has original PDF pages to render. */
  pdf: boolean;
  threadCount: number;
  lastActivity: string;
}

/** Office-family kinds that SHOULD have converted PDF pages — pdf:false on these means the Gotenberg conversion fell back to reflow text. */
const CONVERTIBLE = new Set(["docx", "doc", "odt", "rtf", "pptx", "ppt"]);

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

interface RecentsPanelProps {
  currentDocId: string;
  userId: string;
  plan: Plan;
}

/**
 * ChatGPT-style session list: each entry is a document with all its chats.
 * Expands from the header, retracts to nothing. "+" starts a new session,
 * whose first step is uploading a document.
 */
export function RecentsPanel({ currentDocId, userId, plan }: RecentsPanelProps) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<RecentSession[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function deleteSession(id: string) {
    if (deletingId) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/documents/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`delete failed (${res.status})`);
      const rest = (sessions ?? []).filter((s) => s.documentId !== id);
      setSessions(rest);
      if (id === currentDocId) {
        const next = rest.find((s) => s.status === "ready");
        window.location.href = next ? `/read/${next.documentId}` : "/";
        return;
      }
    } catch {
      // keep the list as it is — the row simply stays
    }
    setDeletingId(null);
    setConfirmId(null);
  }

  const loadSessions = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch("/api/recents");
      if (!res.ok) throw new Error(`recents failed (${res.status})`);
      const data = (await res.json()) as { sessions?: RecentSession[] };
      setSessions(data.sessions ?? []);
    } catch {
      // A fetch error is NOT an empty account — show a retryable error state.
      setSessions(null);
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setConfirmId(null);
      return;
    }
    void loadSessions();
    const onKey = (e: KeyboardEvent & { rdEscHandled?: boolean }) => {
      if (e.key !== "Escape" || e.rdEscHandled) return; // one layer per Esc
      e.rdEscHandled = true;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, loadSessions]);

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
          open ? "bg-neutral-100 text-black" : "text-neutral-500 hover:bg-neutral-100 hover:text-black"
        }`}
      >
        Recents
        <span
          className={`text-[10px] text-neutral-400 transition-transform ${open ? "rotate-180" : ""}`}
        >
          ▼
        </span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border border-neutral-300 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06),0_14px_40px_rgba(0,0,0,0.14)]">
            <button
              onClick={() => {
                setOpen(false);
                setUploadOpen(true);
              }}
              className="flex w-full items-center gap-2.5 border-b border-neutral-200 px-3.5 py-2.5 text-left text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-50"
            >
              <span className="grid h-5 w-5 place-items-center rounded-md bg-neutral-900 text-xs text-white">
                +
              </span>
              New session
            </button>

            <div className="max-h-[60vh] overflow-y-auto py-1">
              {sessions === null && !loadError && (
                <p className="px-3.5 py-3 text-xs text-neutral-400">Loading…</p>
              )}
              {loadError && (
                <div className="px-3.5 py-3 text-center">
                  <p className="mb-2 text-xs text-neutral-500">Couldn&rsquo;t load your sessions.</p>
                  <button
                    onClick={() => void loadSessions()}
                    data-testid="recents-retry"
                    className="rounded-md border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 transition-colors hover:border-neutral-500"
                  >
                    Retry
                  </button>
                </div>
              )}
              {sessions?.length === 0 && (
                <p className="px-3.5 py-3 text-xs text-neutral-400">
                  Nothing yet — highlight a passage in any document and it will show up here.
                </p>
              )}
              {sessions?.map((s) => {
                const failed = s.status === "failed";
                const processing = s.status === "processing";
                const noOriginalPages = s.status === "ready" && !s.pdf && CONVERTIBLE.has(s.kind);
                const body = (
                  <>
                    <span
                      className={`block truncate text-[13px] font-medium ${
                        failed ? "text-neutral-400" : "text-neutral-800"
                      }`}
                    >
                      {s.title}
                    </span>
                    <span className="block text-[11px] text-neutral-400">
                      {failed ? (
                        <span className="font-medium text-red-400">Failed</span>
                      ) : processing ? (
                        <>
                          <span className="mr-1.5 inline-block h-2.5 w-2.5 animate-spin rounded-full border border-neutral-300 border-t-neutral-600 align-[-1px]" />
                          Processing…
                        </>
                      ) : (
                        <>
                          {s.threadCount === 1 ? "1 thread" : `${s.threadCount} threads`} ·{" "}
                          {timeAgo(s.lastActivity)}
                          {s.documentId === currentDocId && " · current"}
                          {noOriginalPages && (
                            <span data-testid="recents-no-pdf-hint"> · no original pages</span>
                          )}
                        </>
                      )}
                    </span>
                  </>
                );
                return (
                  <div
                    key={s.documentId}
                    data-testid={failed ? "recents-row-failed" : undefined}
                    onMouseLeave={() => {
                      if (confirmId === s.documentId && deletingId !== s.documentId) setConfirmId(null);
                    }}
                    className={`group relative transition-colors ${
                      failed ? "opacity-70" : "hover:bg-neutral-50"
                    } ${s.documentId === currentDocId ? "bg-neutral-50" : ""}`}
                  >
                    {s.status === "ready" ? (
                      <a
                        href={`/read/${s.documentId}`}
                        aria-current={s.documentId === currentDocId ? "true" : undefined}
                        className="block px-3.5 py-2 pr-16"
                      >
                        {body}
                      </a>
                    ) : (
                      // failed / processing sessions cannot be opened — plain row
                      <div className="block cursor-default px-3.5 py-2 pr-16">{body}</div>
                    )}
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (confirmId === s.documentId) void deleteSession(s.documentId);
                        else setConfirmId(s.documentId);
                      }}
                      aria-label={`Delete session "${s.title}"`}
                      title="Delete this session — the document and all its chats"
                      className={`absolute right-2 top-1/2 flex h-6 -translate-y-1/2 items-center justify-center rounded-md transition-all ${
                        confirmId === s.documentId
                          ? "bg-red-600 px-2 text-[11px] font-semibold text-white hover:bg-red-700"
                          : "w-6 text-neutral-500 opacity-0 hover:bg-neutral-200 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100"
                      }`}
                    >
                      {deletingId === s.documentId ? (
                        <span className="block h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                      ) : confirmId === s.documentId ? (
                        "Delete?"
                      ) : (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6" />
                        </svg>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      <NewSessionModal open={uploadOpen} onClose={() => setUploadOpen(false)} userId={userId} plan={plan} />
      {/* Background-upload completion/failure toast — mounted here because the header outlives the dialog. */}
      <UploadToast />
    </div>
  );
}

/* ---------------- new session = upload a document first ---------------- */

function NewSessionModal({
  open,
  onClose,
  userId,
  plan,
}: {
  open: boolean;
  onClose: () => void;
  userId: string;
  plan: Plan;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const { job, error, start, cancel, dismiss } = useUploadDocument(userId);
  const openRef = useRef(open);

  // The dialog registers itself with the upload manager: while it is open a
  // finishing upload auto-navigates; once closed, the upload continues in the
  // background and completion surfaces as a toast instead.
  useEffect(() => {
    openRef.current = open;
    setUploadDialogOpen(open);
    if (open) dismiss(); // clear a stale done/failed state from a previous run
    return () => {
      openRef.current = false;
      setUploadDialogOpen(false);
    };
  }, [open, dismiss]);

  // Esc closes at ANY time — window-level so it works regardless of focus.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent & { rdEscHandled?: boolean }) => {
      if (e.key !== "Escape" || e.rdEscHandled) return; // one layer per Esc
      e.rdEscHandled = true;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function handleFile(file: File) {
    const created = await start(file);
    // Only navigate if the dialog is STILL open — a background completion
    // is announced by the toast instead of yanking the user away.
    if (created && openRef.current) window.location.href = `/read/${created.id}`;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[20vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="New session"
        className="w-[min(26rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-neutral-300 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06),0_18px_50px_rgba(0,0,0,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-2.5">
          <span className="flex-1 text-xs font-semibold uppercase tracking-wider text-neutral-500">
            New session
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
          {plan !== "pro" ? (
            <div className="text-center text-sm text-neutral-600">
              <p className="mb-3">Uploading your own documents requires Pro.</p>
              <a
                href="/settings"
                className="inline-block rounded-lg bg-neutral-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-black"
              >
                Upgrade
              </a>
            </div>
          ) : job.kind === "active" ? (
            <UploadProgress job={job} onCancel={cancel} />
          ) : (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const file = e.dataTransfer.files[0];
                if (file) void handleFile(file);
              }}
              className={`rounded-lg border-2 border-dashed px-4 py-7 text-center transition-colors ${
                dragOver ? "border-neutral-800 bg-neutral-50" : "border-neutral-300"
              }`}
            >
              <p className="mb-1 text-sm font-medium text-neutral-800">
                Start by uploading a document
              </p>
              <p className="mb-4 text-xs text-neutral-400">
                PDF, DOCX, EPUB, MOBI, TXT and more · up to {MAX_UPLOAD_MB} MB
              </p>
              <button
                onClick={() => inputRef.current?.click()}
                className="rounded-lg bg-neutral-900 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-black"
              >
                Choose a file
              </button>
              <input
                ref={inputRef}
                type="file"
                accept={UPLOAD_ACCEPT}
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                  e.target.value = "";
                }}
              />
            </div>
          )}
          {error && <p className="mt-3 text-center text-xs text-red-700">{error}</p>}
        </div>
      </div>
    </div>
  );
}
