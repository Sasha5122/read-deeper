"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  UPLOAD_ACCEPT,
  UploadProgress,
  useUploadDocument,
} from "@/components/upload/useUploadDocument";
import { MAX_UPLOAD_MB } from "@/lib/upload-limits";
import type { Plan } from "@/lib/types";

export function UploadPanel({ userId, plan }: { userId: string; plan: Plan }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const { job, error, start, cancel, dismiss } = useUploadDocument(userId);

  async function handleFile(file: File) {
    const created = await start(file);
    if (created) {
      dismiss();
      router.refresh();
    }
  }

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
      {job.kind === "active" ? (
        <UploadProgress job={job} onCancel={cancel} />
      ) : (
        <>
          <p className="mb-1 font-semibold">Drop a document here</p>
          <p className="mb-4 text-sm text-ink-soft">
            PDF, DOCX, EPUB, MOBI, TXT and more — up to {MAX_UPLOAD_MB} MB
          </p>
          <button
            onClick={() => inputRef.current?.click()}
            className="rounded-md border border-line px-4 py-2 text-sm font-semibold hover:border-accent"
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
        </>
      )}
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </div>
  );
}
