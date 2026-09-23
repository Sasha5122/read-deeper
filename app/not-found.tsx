import Link from "next/link";

/** App-wide 404 — also shown when a read page calls notFound() for a missing/unready document. */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-8 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <p className="mb-1 font-[family-name:var(--font-display)] text-4xl text-ink-faint">404</p>
        <h1 className="mb-2 text-lg font-semibold text-ink">
          This document doesn&rsquo;t exist or is no longer available.
        </h1>
        <p className="mb-6 text-sm text-ink-soft">
          It may have been deleted, or the link is wrong.
        </p>
        <Link
          href="/"
          className="inline-block rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-black"
        >
          Back to your sessions
        </Link>
      </div>
    </main>
  );
}
