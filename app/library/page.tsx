import Link from "next/link";
import { Nav } from "@/components/Nav";
import { createSupabaseServer } from "@/lib/supabase/server";
import type { Shelf } from "@/lib/types";

const SHELF_LABELS: Record<Shelf, string> = {
  stoicism: "Stoicism",
  economics: "Economics",
  physics: "Physics",
  psychology: "Psychology",
  history: "History",
  founding: "Founding Documents",
};

export default async function LibraryPage() {
  const supabase = await createSupabaseServer();

  const { data: books } = await supabase
    .from("library_books")
    .select("*")
    .order("sort_order", { ascending: true });
  const { data: documents } = await supabase
    .from("documents")
    .select("*")
    .eq("source", "library")
    .eq("status", "ready");

  const docById = new Map((documents ?? []).map((d) => [d.id, d]));
  const shelves = new Map<Shelf, NonNullable<typeof books>>();
  for (const book of books ?? []) {
    if (!docById.has(book.document_id)) continue;
    const list = shelves.get(book.shelf) ?? [];
    list.push(book);
    shelves.set(book.shelf, list);
  }

  return (
    <>
      <Nav active="library" />
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="mb-8 font-[family-name:var(--font-display)] text-3xl font-semibold">
          The Library
        </h1>
        {shelves.size === 0 && (
          <p className="rounded-lg border border-line bg-surface p-6 text-ink-soft">
            The library is empty. Run <code className="rounded bg-accent-wash px-1">npm run seed</code>{" "}
            to load the public-domain shelf.
          </p>
        )}
        {Array.from(shelves.entries()).map(([shelf, list]) => (
          <section key={shelf} className="mb-10">
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-ink-faint">
              {SHELF_LABELS[shelf]}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((book) => {
                const doc = docById.get(book.document_id)!;
                return (
                  <Link
                    key={book.document_id}
                    href={`/read/${book.document_id}`}
                    className="group rounded-lg border border-line bg-surface p-5 transition-colors hover:border-accent"
                  >
                    <h3 className="font-[family-name:var(--font-display)] text-lg font-semibold group-hover:text-accent-deep">
                      {doc.title}
                    </h3>
                    <p className="mb-2 text-sm text-ink-soft">{doc.author}</p>
                    {book.blurb && <p className="mb-3 text-sm text-ink-soft">{book.blurb}</p>}
                    <p className="text-xs text-ink-faint">
                      {book.era && <span>{book.era} · </span>}
                      {book.reading_minutes && <span>~{book.reading_minutes} min · </span>}
                      {book.difficulty && <span>{"●".repeat(book.difficulty)}{"○".repeat(5 - book.difficulty)}</span>}
                    </p>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </main>
    </>
  );
}
