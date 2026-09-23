"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { createSupabaseBrowser } from "@/lib/supabase/client";
import { fileTooLargeMessage, MAX_UPLOAD_BYTES } from "@/lib/upload-limits";
import type { DocumentKind } from "@/lib/types";

/** Extension → document kind, shared by every upload surface. */
export const KIND_BY_EXT: Record<string, DocumentKind> = {
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

export const UPLOAD_ACCEPT =
  ".pdf,.docx,.doc,.pptx,.ppt,.epub,.mobi,.azw,.azw3,.txt,.md,.rtf,.odt,.html,.htm";

/**
 * One upload job at a time, held at MODULE level so it survives the
 * New-session dialog closing (the upload keeps running in the background and
 * completion surfaces as a toast instead of a forced navigation).
 */
export type UploadJob =
  | { kind: "idle" }
  | {
      kind: "active";
      stage: "upload" | "extract" | "open";
      /** 0–100, continuous across the WHOLE pipeline — never stalls. */
      percent: number;
      fileName: string;
      title: string;
    }
  | { kind: "done"; documentId: string; title: string }
  | {
      kind: "failed";
      error: string;
      title: string;
      /** True when the dialog was open at failure time — it shows the error inline, so the toast stays quiet. */
      inDialog: boolean;
    };

const IDLE: UploadJob = { kind: "idle" };
let jobState: UploadJob = IDLE;
const listeners = new Set<() => void>();
let dialogOpen = false;
let activeXhr: XMLHttpRequest | null = null;
let activeAbort: AbortController | null = null;
let progressTimer: ReturnType<typeof setInterval> | null = null;
let cancelled = false;

function emit(next: UploadJob) {
  jobState = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const getSnapshot = () => jobState;
const getServerSnapshot = () => IDLE;

function stopProgressTimer() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

/** The New-session dialog registers itself so completion knows whether to auto-navigate (dialog open) or toast (dialog closed). */
export function setUploadDialogOpen(open: boolean) {
  dialogOpen = open;
}

/** Abort the in-flight upload. The storage PUT is truly cancelled; if extraction was already running server-side it cannot be stopped mid-request — the document may still finish and appear in Recents (deletable there). */
function cancelUpload() {
  if (jobState.kind !== "active") return;
  cancelled = true;
  activeXhr?.abort();
  activeAbort?.abort();
  stopProgressTimer();
  emit(IDLE);
}

/** Clear a finished (done/failed) job — dismisses the toast / inline error. No-op while active. */
function dismissUpload() {
  if (jobState.kind === "done" || jobState.kind === "failed") emit(IDLE);
}

/**
 * Upload the file bytes straight to Supabase Storage via XMLHttpRequest —
 * fetch (and supabase-js, which uses it) exposes no upload progress events.
 * Same endpoint and auth the supabase-js client would use.
 */
async function uploadToStorageWithProgress(
  filePath: string,
  file: File,
  onProgress: (percent: number) => void,
  onXhr: (xhr: XMLHttpRequest) => void,
): Promise<void> {
  const supabase = createSupabaseBrowser();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not signed in — please reload and try again.");

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const url = `${base}/storage/v1/object/uploads/${filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    onXhr(xhr);
    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("apikey", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `Upload failed (${xhr.status})`;
      try {
        const body = JSON.parse(xhr.responseText) as { message?: string; error?: string };
        message = body.message ?? body.error ?? message;
      } catch {
        // non-JSON error body — keep the status message
      }
      reject(new Error(message));
    };
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    xhr.onerror = () => reject(new Error("Upload failed — network error."));
    xhr.send(file);
  });
}

/** Progress mapping: real upload % fills 0–35; extraction (unknown duration) eases asymptotically 35→90 with an ~8s time constant; success jumps to 100. */
const UPLOAD_SHARE = 35;
const EXTRACT_CEILING = 90;
const EXTRACT_TAU_MS = 8000;

async function startUpload(userId: string, file: File): Promise<{ id: string } | null> {
  if (jobState.kind === "active") return null; // one upload at a time
  const title = file.name.replace(/\.[^.]+$/, "");
  const failNow = (message: string) => {
    emit({ kind: "failed", error: message, title, inDialog: dialogOpen });
    return null;
  };

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const kind = KIND_BY_EXT[ext];
  if (!kind) {
    return failNow(
      "Supported: PDF, DOCX, DOC, PPTX, PPT, EPUB, MOBI/AZW, TXT, MD, RTF, ODT, HTML.",
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) return failNow(fileTooLargeMessage(file.size));

  cancelled = false;
  emit({ kind: "active", stage: "upload", percent: 0, fileName: file.name, title });
  try {
    const filePath = `${userId}/${Date.now()}-${file.name.replace(/[^\w.\- ]+/g, "")}`;
    await uploadToStorageWithProgress(
      filePath,
      file,
      (percent) => {
        if (jobState.kind === "active") {
          emit({ ...jobState, percent: Math.round(percent * (UPLOAD_SHARE / 100)) });
        }
      },
      (xhr) => (activeXhr = xhr),
    );
    activeXhr = null;
    if (cancelled) return null;

    // Extraction: duration unknown — ease the SAME bar toward 90 so it never stalls.
    const startedAt = Date.now();
    emit({ kind: "active", stage: "extract", percent: UPLOAD_SHARE, fileName: file.name, title });
    progressTimer = setInterval(() => {
      if (jobState.kind !== "active") return;
      const eased =
        UPLOAD_SHARE +
        (EXTRACT_CEILING - UPLOAD_SHARE) *
          (1 - Math.exp(-(Date.now() - startedAt) / EXTRACT_TAU_MS));
      emit({ ...jobState, percent: Math.min(EXTRACT_CEILING, Math.round(eased * 10) / 10) });
    }, 200);

    activeAbort = new AbortController();
    const res = await fetch("/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, filePath, kind }),
      signal: activeAbort.signal,
    });
    const data = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
    if (!res.ok || !data?.id) throw new Error(data?.error ?? `Upload failed (${res.status})`);

    stopProgressTimer();
    if (cancelled) return null;
    if (dialogOpen) {
      // The dialog is still up: it auto-navigates (today's behavior) — show the full bar meanwhile.
      emit({ kind: "active", stage: "open", percent: 100, fileName: file.name, title });
    } else {
      // Background completion: no forced navigation — the toast offers "Open".
      emit({ kind: "done", documentId: data.id, title });
    }
    return { id: data.id };
  } catch (err) {
    stopProgressTimer();
    if (cancelled || (err instanceof DOMException && err.name === "AbortError")) {
      emit(IDLE);
      return null;
    }
    return failNow(err instanceof Error ? err.message : "Upload failed");
  } finally {
    stopProgressTimer();
    activeXhr = null;
    activeAbort = null;
  }
}

/**
 * Shared upload flow: validate → upload with real progress → register with
 * /api/documents (extraction) → hand the created document back to the caller.
 * State lives at module level, so it survives the dialog unmounting.
 */
export function useUploadDocument(userId: string) {
  const job = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const start = useCallback((file: File) => startUpload(userId, file), [userId]);
  return {
    job,
    error: job.kind === "failed" ? job.error : "",
    start,
    cancel: cancelUpload,
    dismiss: dismissUpload,
  };
}

/** ONE continuous bar 0→100 across the whole pipeline, shared by both surfaces. */
export function UploadProgress({ job, onCancel }: { job: UploadJob; onCancel?: () => void }) {
  if (job.kind !== "active") return null;
  const label =
    job.stage === "upload" ? "Uploading…" : job.stage === "extract" ? "Preparing…" : "Opening…";
  return (
    <div data-testid="upload-progress" className="py-4 text-center text-sm text-neutral-600">
      <p className="mb-2 truncate text-xs text-neutral-400">{job.fileName}</p>
      <div className="mx-auto mb-2 h-1.5 w-48 overflow-hidden rounded-full bg-neutral-200">
        <div
          data-testid="upload-progress-bar"
          className="h-full rounded-full bg-neutral-800 transition-[width] duration-200 ease-out"
          style={{ width: `${job.percent}%` }}
        />
      </div>
      <p className="text-xs text-neutral-400">{label}</p>
      {onCancel && (
        <button
          onClick={onCancel}
          data-testid="upload-cancel"
          className="mt-3 rounded-md border border-neutral-300 px-3 py-1 text-xs text-neutral-600 transition-colors hover:border-neutral-500 hover:text-neutral-900"
        >
          Cancel
        </button>
      )}
    </div>
  );
}

/**
 * Fixed bottom-right toast for uploads that finished AFTER their dialog was
 * closed: "«title» is ready — Open" (or the failure message). Auto-hides
 * after 15s. Mount it once on any surface that stays up (RecentsPanel does).
 */
export function UploadToast() {
  const job = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const visible = job.kind === "done" || (job.kind === "failed" && !job.inDialog);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => dismissUpload(), 15_000);
    return () => clearTimeout(timer);
  }, [visible, job]);

  if (!visible) return null;
  return (
    <div
      data-testid="upload-done-toast"
      className="fixed bottom-4 right-4 z-[70] flex max-w-sm items-center gap-3 rounded-xl border border-neutral-300 bg-white px-4 py-3 text-sm shadow-[0_1px_2px_rgba(0,0,0,0.06),0_14px_40px_rgba(0,0,0,0.14)]"
    >
      {job.kind === "done" ? (
        <>
          <span className="min-w-0 flex-1 text-neutral-800">
            «<span className="font-medium">{job.title}</span>» is ready
          </span>
          <a
            href={`/read/${job.documentId}`}
            data-testid="upload-open-btn"
            className="shrink-0 rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-black"
          >
            Open
          </a>
        </>
      ) : (
        <span className="min-w-0 flex-1 text-neutral-800">
          «<span className="font-medium">{job.title}</span>» failed: {job.error}
        </span>
      )}
      <button
        onClick={dismissUpload}
        aria-label="Dismiss"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-800"
      >
        ✕
      </button>
    </div>
  );
}
