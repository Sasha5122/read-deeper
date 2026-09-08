/**
 * Seed the library with 6 public-domain books from Project Gutenberg.
 * Run with: npm run seed   (requires .env.local with Supabase service role key)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { buildOffsets, normalize, paginate } from "../lib/extract";
import type { Database, Shelf } from "../lib/types";

// Minimal .env.local loader (no dotenv dependency).
try {
  const envFile = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  // fall back to the process environment
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (e.g. in .env.local)");
  process.exit(1);
}
const admin = createClient<Database>(url, key, { auth: { persistSession: false } });

interface SeedBook {
  title: string;
  author: string;
  shelf: Shelf;
  era: string;
  difficulty: number;
  blurb: string;
  url: string;
  /** Optional slice markers applied after Gutenberg header/footer stripping. */
  from?: string;
  to?: string;
  /** Use the LAST occurrence of `from` (skips a table of contents). */
  fromLast?: boolean;
}

const BOOKS: SeedBook[] = [
  {
    title: "Meditations",
    author: "Marcus Aurelius",
    shelf: "stoicism",
    era: "c. 170 AD",
    difficulty: 2,
    blurb: "The Roman emperor's private notes on how to live.",
    url: "https://www.gutenberg.org/cache/epub/2680/pg2680.txt",
  },
  {
    title: "The Enchiridion",
    author: "Epictetus",
    shelf: "stoicism",
    era: "c. 125 AD",
    difficulty: 2,
    blurb: "A short Stoic manual on what is and isn't in your control.",
    url: "https://www.gutenberg.org/cache/epub/45109/pg45109.txt",
  },
  {
    title: "The Wealth of Nations (Book I, ch. 1–3)",
    author: "Adam Smith",
    shelf: "economics",
    era: "1776",
    difficulty: 4,
    blurb: "Division of labour and the origin of markets — the founding text of economics.",
    url: "https://www.gutenberg.org/cache/epub/3300/pg3300.txt",
    from: "CHAPTER I.\nOF THE DIVISION OF LABOUR",
    to: "CHAPTER IV.\nOF THE ORIGIN AND USE OF MONEY",
  },
  {
    title: "Relativity: The Special and General Theory",
    author: "Albert Einstein",
    shelf: "physics",
    era: "1916",
    difficulty: 4,
    blurb: "Einstein explains his own theory for the general reader.",
    url: "https://www.gutenberg.org/cache/epub/30155/pg30155.txt",
  },
  {
    title: "On the Origin of Species (ch. 1–4)",
    author: "Charles Darwin",
    shelf: "history",
    era: "1859",
    difficulty: 3,
    blurb: "Variation, struggle, and natural selection — the argument that changed biology.",
    url: "https://www.gutenberg.org/cache/epub/1228/pg1228.txt",
    from: "CHAPTER I.",
    to: "CHAPTER V.",
  },
  {
    title: "The Federalist Papers (No. 1–10)",
    author: "Hamilton, Madison, Jay",
    shelf: "founding",
    era: "1787–88",
    difficulty: 4,
    blurb: "The case for the American Constitution, argued in public.",
    url: "https://www.gutenberg.org/cache/epub/1404/pg1404.txt",
    from: "FEDERALIST No. 1",
    to: "FEDERALIST No. 11",
  },
];

function stripGutenberg(raw: string): string {
  let text = raw;
  const start = text.search(/\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\*\*\*/i);
  if (start !== -1) text = text.slice(text.indexOf("\n", start) + 1);
  const end = text.search(/\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG/i);
  if (end !== -1) text = text.slice(0, end);
  return text.trim();
}

function sliceChapters(text: string, from?: string, to?: string, fromLast?: boolean): string {
  let out = text;
  if (from) {
    const i = fromLast ? out.lastIndexOf(from) : out.indexOf(from);
    if (i !== -1) out = out.slice(i);
  }
  if (to) {
    const j = out.indexOf(to, 10);
    if (j !== -1) out = out.slice(0, j);
  }
  return out.trim();
}

async function seedBook(book: SeedBook, sortOrder: number): Promise<void> {
  const { data: existing } = await admin
    .from("documents")
    .select("id")
    .eq("source", "library")
    .eq("title", book.title)
    .maybeSingle();
  if (existing) {
    console.log(`— ${book.title} already seeded, skipping`);
    return;
  }

  console.log(`Fetching ${book.title}…`);
  const res = await fetch(book.url);
  if (!res.ok) throw new Error(`${book.url} returned ${res.status}`);
  const raw = await res.text();
  const text = sliceChapters(stripGutenberg(normalize(raw)), book.from, book.to, book.fromLast);
  if (text.length < 5000) throw new Error(`Extracted text suspiciously short (${text.length})`);

  const { data: doc, error: docErr } = await admin
    .from("documents")
    .insert({
      owner_id: null,
      title: book.title,
      author: book.author,
      source: "library",
      file_path: null,
      kind: "txt",
      status: "processing",
    })
    .select("*")
    .single();
  if (docErr || !doc) throw new Error(docErr?.message ?? "insert failed");

  const rows = buildOffsets(doc.id, paginate(text));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("document_text").insert(rows.slice(i, i + 500));
    if (error) throw new Error(error.message);
  }

  const { error: bookErr } = await admin.from("library_books").insert({
    document_id: doc.id,
    shelf: book.shelf,
    era: book.era,
    difficulty: book.difficulty,
    reading_minutes: Math.round(text.split(/\s+/).length / 220),
    blurb: book.blurb,
    sort_order: sortOrder,
  });
  if (bookErr) throw new Error(bookErr.message);

  await admin.from("documents").update({ status: "ready" }).eq("id", doc.id);
  console.log(`✓ ${book.title} (${rows.length} pages)`);
}

async function main() {
  for (let i = 0; i < BOOKS.length; i++) {
    try {
      await seedBook(BOOKS[i], i);
    } catch (err) {
      console.error(`✗ ${BOOKS[i].title}:`, err instanceof Error ? err.message : err);
    }
  }
}

void main();
