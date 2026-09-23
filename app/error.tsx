"use client"; // error boundaries must be Client Components

import { useEffect } from "react";

/**
 * App-wide error boundary (Next 16 convention: the `retry` prop re-fetches and
 * re-renders the failed segment; `reset` is kept as a fallback for safety).
 */
export default function ErrorPage({
  error,
  retry,
  reset,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
  reset?: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-8 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <h1 className="mb-2 text-lg font-semibold text-ink">Something went wrong.</h1>
        <p className="mb-6 text-sm text-ink-soft">
          The page hit an unexpected error. Trying again usually fixes it.
        </p>
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => (retry ?? reset)?.()}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-black"
          >
            Try again
          </button>
          <a
            href="/"
            className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition-colors hover:border-neutral-400 hover:text-ink"
          >
            Back to your sessions
          </a>
        </div>
      </div>
    </main>
  );
}
