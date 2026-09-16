import Link from "next/link";

/** Minimal chrome for the few non-reader pages (settings). */
export function Nav({ active }: { active: "settings" }) {
  void active;
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-ground/95 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3">
        <Link
          href="/"
          className="mr-auto font-[family-name:var(--font-display)] text-lg font-semibold"
        >
          Read <span className="text-accent-deep italic">Deeper</span>
        </Link>
        <Link
          href="/"
          className="rounded-full px-3 py-1.5 text-sm font-semibold text-ink-soft hover:text-ink"
        >
          ← Back to reading
        </Link>
      </div>
    </header>
  );
}
