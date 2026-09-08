"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase/client";
import type { Plan } from "@/lib/types";

const KIND_BY_EXT: Record<string, "pdf" | "docx" | "doc" | "epub" | "mobi" | "txt" | "rtf" | "odt" | "html"> = {
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
};

export function UploadPanel({ userId, plan }: { userId: string; plan: Plan }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const handleFile = useCallback(
    async (file: File) => {
      setError("");
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const kind = KIND_BY_EXT[ext];
      if (!kind) {
        setError("Supported: PDF, DOCX, DOC, EPUB, MOBI/AZW, TXT, MD, RTF, ODT, HTML.");
        return;
      }
      if (file.size > 25 * 1024 * 1024) {
        setError("Files are limited to 25 MB.");
        return;
      }
      setBusy(`Uploading ${file.name}…`);
      try {
        const supabase = createSupabaseBrowser();
        const filePath = `${userId}/${Date.now()}-${file.name.replace(/[^\w.\- ]+/g, "")}`;
        const { error: upErr } = await supabase.storage.from("uploads").upload(filePath, file);
        if (upErr) throw new Error(upErr.message);

        setBusy(`Extracting text from ${file.name}…`);
        const res = await fetch("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: file.name.replace(/\.[^.]+$/, ""),
            filePath,
            kind,
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? `Upload failed (${res.status})`);
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setBusy(null);
      }
    },
    [router, userId],
  );

  if (plan !== "pro") {
    return (
      <div className="rounded-lg border border-dashed border-line bg-surface p-6 text-center">
        <p className="mb-2 font-semibold">Uploading your own documents is a Pro feature.</p>
        <p className="mb-4 text-sm text-ink-soft">
          Free accounts can read and discuss everything in the library.
        </p>
        <a
          href="/settings"
          className="inline-block rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-deep"
        >
          Upgrade to Pro
        </a>
      </div>
    );
  }

  return (
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
      className={`rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
        dragOver ? "border-accent bg-accent-wash" : "border-line bg-surface"
      }`}
    >
      {busy ? (
        <p className="text-sm text-ink-soft">{busy}</p>
      ) : (
        <>
          <p className="mb-1 font-semibold">Drop a document here</p>
          <p className="mb-4 text-sm text-ink-soft">PDF, DOCX, EPUB, MOBI, TXT and more — up to 25 MB</p>
          <button
            onClick={() => inputRef.current?.click()}
            className="rounded-md border border-line px-4 py-2 text-sm font-semibold hover:border-accent"
          >
            Choose a file
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.docx,.doc,.epub,.mobi,.azw,.azw3,.txt,.md,.rtf,.odt,.html,.htm"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              e.target.value = "";
            }}
          />
        </>
      )}
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </div>
  );
}
