import Link from "next/link";

export function Nav({ active }: { active: "library" | "documents" | "settings" }) {
  const link = (href: string, key: string, label: string) => (
    <Link
      href={href}
      className={`rounded-full px-3 py-1.5 text-sm font-semibold ${
        active === key ? "bg-accent-wash text-accent-deep" : "text-ink-soft hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-ground/95 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3">
        <Link
          href="/library"
          className="mr-auto font-[family-name:var(--font-display)] text-lg font-semibold"
        >
          Read <span className="text-accent-deep italic">Deeper</span>
        </Link>
        {link("/library", "library", "Library")}
        {link("/documents", "documents", "My documents")}
        {link("/settings", "settings", "Settings")}
      </div>
    </header>
  );
}
