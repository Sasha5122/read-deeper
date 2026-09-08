"use client";

import { useState } from "react";

/** "Ask about the whole document" — one-shot streamed answer in the left rail. */
export function DocumentAsk({ documentId }: { documentId: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function ask() {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError("");
    setAnswer("");
    try {
      const res = await fetch("/api/document-ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, question: q }),
      });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Request failed");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
        setAnswer(full);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <textarea
        rows={2}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void ask();
          }
        }}
        placeholder="Ask about the whole document…"
        className="resize-none rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm"
      />
      <button
        onClick={() => void ask()}
        disabled={busy || question.trim().length === 0}
        className="self-start rounded-md border border-line px-3 py-1 text-xs font-semibold text-ink-soft hover:border-accent hover:text-accent-deep disabled:opacity-50"
      >
        {busy ? "Thinking…" : "Ask the document"}
      </button>
      {answer !== null && (
        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-surface p-3 text-sm leading-relaxed">
          {answer}
          {busy && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-accent align-text-bottom" />}
        </div>
      )}
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
