"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

export type UploadPhase =
  | { kind: "idle" }
  | { kind: "uploading"; percent: number; fileName: string }
  | { kind: "extracting"; seconds: number; fileName: string }
  | { kind: "opening"; fileName: string };

/**
 * Upload the file bytes straight to Supabase Storage via XMLHttpRequest —
 * fetch (and supabase-js, which uses it) exposes no upload progress events.
 * Same endpoint and auth the supabase-js client would use.
 */
async function uploadToStorageWithProgress(
  filePath: string,
  file: File,
  onProgress: (percent: number) => void,
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
    xhr.onerror = () => reject(new Error("Upload failed — network error."));
    xhr.send(file);
  });
}

/**
 * Shared upload flow: validate → upload with real progress → register with
 * /api/documents (extraction) → hand the created document back to the caller.
 */
export function useUploadDocument(userId: string) {
  const [phase, setPhase] = useState<UploadPhase>({ kind: "idle" });
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reset = useCallback(() => {
    setPhase({ kind: "idle" });
    setError("");
  }, []);

  const start = useCallback(
    async (file: File): Promise<{ id: string } | null> => {
      setError("");
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const kind = KIND_BY_EXT[ext];
      if (!kind) {
        setError("Supported: PDF, DOCX, DOC, PPTX, PPT, EPUB, MOBI/AZW, TXT, MD, RTF, ODT, HTML.");
        return null;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setError(fileTooLargeMessage(file.size));
        return null;
      }

      let timer: ReturnType<typeof setInterval> | null = null;
      try {
        setPhase({ kind: "uploading", percent: 0, fileName: file.name });
        const filePath = `${userId}/${Date.now()}-${file.name.replace(/[^\w.\- ]+/g, "")}`;
        await uploadToStorageWithProgress(filePath, file, (percent) => {
          if (mounted.current) setPhase({ kind: "uploading", percent, fileName: file.name });
        });

        const startedAt = Date.now();
        setPhase({ kind: "extracting", seconds: 0, fileName: file.name });
        timer = setInterval(() => {
          if (mounted.current) {
            setPhase({
              kind: "extracting",
              seconds: Math.round((Date.now() - startedAt) / 1000),
              fileName: file.name,
            });
          }
        }, 1000);

        const res = await fetch("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: file.name.replace(/\.[^.]+$/, ""), filePath, kind }),
        });
        const data = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
        if (!res.ok || !data?.id) throw new Error(data?.error ?? `Upload failed (${res.status})`);

        clearInterval(timer);
        timer = null;
        if (mounted.current) setPhase({ kind: "opening", fileName: file.name });
        return { id: data.id };
      } catch (err) {
        if (mounted.current) {
          setPhase({ kind: "idle" });
          setError(err instanceof Error ? err.message : "Upload failed");
        }
        return null;
      } finally {
        if (timer) clearInterval(timer);
      }
    },
    [userId],
  );

  return { phase, error, start, reset };
}

/** Phase display shared by the upload panel and the New-session dialog. */
export function UploadProgress({ phase }: { phase: UploadPhase }) {
  if (phase.kind === "idle") return null;
  const label =
    phase.kind === "uploading"
      ? `Uploading… ${phase.percent}%`
      : phase.kind === "extracting"
        ? `Extracting text…${phase.seconds >= 5 ? ` ${phase.seconds}s` : ""}`
        : "Opening…";
  return (
    <div data-testid="upload-progress" className="py-4 text-center text-sm text-neutral-600">
      <p className="mb-2 truncate text-xs text-neutral-400">{phase.fileName}</p>
      {phase.kind === "uploading" ? (
        <div className="mx-auto mb-2 h-1.5 w-48 overflow-hidden rounded-full bg-neutral-200">
          <div
            className="h-full rounded-full bg-neutral-800 transition-[width] duration-200"
            style={{ width: `${phase.percent}%` }}
          />
        </div>
      ) : (
        <span className="mr-2 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-800 align-middle" />
      )}
      {label}
    </div>
  );
}
