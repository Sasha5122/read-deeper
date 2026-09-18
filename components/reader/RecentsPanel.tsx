"use client";

import { useEffect, useRef, useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase/client";
import type { Plan } from "@/lib/types";

interface RecentSession {
  documentId: string;
  title: string;
  author: string | null;
  status: string;
  threadCount: number;
  lastActivity: string;
}

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
        window.location.href = rest[0] ? `/read/${rest[0].documentId}` : "/";
        return;
      }
    } catch {
      // keep the list as it is — the row simply stays
    }
    setDeletingId(null);
    setConfirmId(null);
  }

  useEffect(() => {
    if (!open) {
      setConfirmId(null);
      return;
    }
    let cancelled = false;
    fetch("/api/recents")
      .then((r) => r.json())
      .then((data: { sessions?: RecentSession[] }) => {
        if (!cancelled) setSessions(data.sessions ?? []);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

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
              {sessions === null && (
                <p className="px-3.5 py-3 text-xs text-neutral-400">Loading…</p>
              )}
              {sessions?.length === 0 && (
                <p className="px-3.5 py-3 text-xs text-neutral-400">
                  Nothing yet — highlight a passage in any document and it will show up here.
                </p>
              )}
              {sessions?.map((s) => (
                <div
                  key={s.documentId}
                  onMouseLeave={() => {
                    if (confirmId === s.documentId && deletingId !== s.documentId) setConfirmId(null);
                  }}
                  className={`group relative transition-colors hover:bg-neutral-50 ${
                    s.documentId === currentDocId ? "bg-neutral-50" : ""
                  }`}
                >
                  <a
                    href={`/read/${s.documentId}`}
                    aria-current={s.documentId === currentDocId ? "true" : undefined}
                    className="block px-3.5 py-2 pr-16"
                  >
                    <span className="block truncate text-[13px] font-medium text-neutral-800">
                      {s.title}
                    </span>
                    <span className="block text-[11px] text-neutral-400">
                      {s.threadCount === 1 ? "1 thread" : `${s.threadCount} threads`} ·{" "}
                      {timeAgo(s.lastActivity)}
                      {s.documentId === currentDocId && " · current"}
                    </span>
                  </a>
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
              ))}
            </div>
          </div>
        </>
      )}

      <NewSessionModal open={uploadOpen} onClose={() => setUploadOpen(false)} userId={userId} plan={plan} />
    </div>
  );
}

/* ---------------- new session = upload a document first ---------------- */

const KIND_BY_EXT: Record<string, "pdf" | "docx" | "doc" | "epub" | "mobi" | "txt" | "rtf" | "odt" | "html" | "pptx" | "ppt"> = {
  pdf: "pdf",
  docx: "docx",
  doc: "doc",
  epub: "epub",
  mobi: "mobi",
  azw: "mobi",
  azw3: "mobi",
  txt: "txt",
  md: "txt",
  markdown: "txt",
  rtf: "rtf",
  odt: "odt",
  html: "html",
  htm: "html",
  pptx: "pptx",
  ppt: "ppt",
};

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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (open) {
      setBusy(null);
      setError("");
    }
  }, [open]);

  if (!open) return null;

  async function handleFile(file: File) {
    setError("");
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const kind = KIND_BY_EXT[ext];
    if (!kind) {
      setError("Supported: PDF, DOCX, DOC, PPTX, PPT, EPUB, MOBI/AZW, TXT, MD, RTF, ODT, HTML.");
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setError("Files are limited to 25 MB.");
      return;
    }
    try {
      setBusy("Uploading…");
      const supabase = createSupabaseBrowser();
      const filePath = `${userId}/${Date.now()}-${file.name.replace(/[^\w.\- ]+/g, "")}`;
      const { error: upErr } = await supabase.storage.from("uploads").upload(filePath, file);
      if (upErr) throw new Error(upErr.message);

      setBusy("Extracting text…");
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: file.name.replace(/\.[^.]+$/, ""), filePath, kind }),
      });
      const data = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
      if (!res.ok || !data?.id) throw new Error(data?.error ?? `Upload failed (${res.status})`);

      setBusy("Opening…");
      window.location.href = `/read/${data.id}`;
    } catch (err) {
      setBusy(null);
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[20vh]"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
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
          ) : busy ? (
            <div className="py-6 text-center text-sm text-neutral-600">
              <span className="mr-2 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-800 align-middle" />
              {busy}
            </div>
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
              <p className="mb-4 text-xs text-neutral-400">PDF, DOCX, EPUB, MOBI, TXT and more · up to 25 MB</p>
              <button
                onClick={() => inputRef.current?.click()}
                className="rounded-lg bg-neutral-900 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-black"
              >
                Choose a file
              </button>
              <input
                ref={inputRef}
                type="file"
                accept=".pdf,.docx,.doc,.pptx,.ppt,.epub,.mobi,.azw,.azw3,.txt,.md,.rtf,.odt,.html,.htm"
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
