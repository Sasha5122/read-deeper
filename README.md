# Read Deeper

Deep reading with AI in the margin. Open a document, select a passage, press **Ask** — a highlight is created and a private chat thread opens in the right margin, anchored to that exact passage. Every highlight has its own persistent thread with its own context.

> *Understand any document, one highlight at a time.*

## Stack

Next.js (App Router, TypeScript, Tailwind) · Supabase (Postgres + Auth + Storage, RLS everywhere) · Anthropic API (streaming) · Stripe (Pro subscriptions). Deployable on Vercel or any Node VPS — no Vercel-only APIs.

## Setup

1. **Supabase** — create a project at [supabase.com](https://supabase.com), then run the migration:
   ```bash
   # in the Supabase SQL editor, paste supabase/migrations/0001_init.sql
   # or with the CLI: supabase link && supabase db push
   ```
   Enable the **Google** provider under Auth → Providers (optional; email magic links work out of the box). Set the Site URL under Auth → URL configuration.

2. **Environment** — copy `.env.example` to `.env.local` and fill in:
   - Supabase URL + anon key + service role key (Project Settings → API)
   - `ANTHROPIC_API_KEY`
   - Stripe keys + a recurring Price ID for Pro (`STRIPE_PRICE_PRO`)

3. **Seed the library** (6 public-domain books from Project Gutenberg):
   ```bash
   npm install
   npm run seed
   ```

4. **Stripe webhook** — point a webhook at `/api/stripe/webhook` with events `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Locally:
   ```bash
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```

5. **Run**:
   ```bash
   npm run dev
   ```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` / `start` | Production build / serve |
| `npm run typecheck` | TypeScript strict check |
| `npm test` | Unit tests (anchoring, offsets, context budget, usage limits) |
| `npm run seed` | Seed the public-domain library |

## How it works

- **Text layer** — documents are extracted server-side into `document_text` pages with global character offsets (`lib/extract.ts`). The reader renders its own HTML text layer from those rows; the full text is exactly the concatenation of page texts, so a highlight is just a `[start, end)` range.
- **Anchoring** — highlights store offsets *plus* the exact quote and ~30 chars of prefix/suffix. If a document is ever reprocessed, `lib/anchoring.ts` re-finds the quote and scores candidates by surrounding-text match.
- **Threads** — one highlight = one thread. Each message sends only that thread's context: the quote, ~600 chars around it, the page number, and the thread's own history trimmed to a token budget (`lib/context.ts`). Never other threads.
- **Models** — `MODEL_THREAD` (default `claude-haiku-4-5`, fast) answers margin threads; `MODEL_DOCUMENT` (default `claude-opus-5`) answers "ask the whole document", which retrieves top-k pages (lexical scoring for now — swap in embeddings without changing the API).
- **Free/Pro** — enforced server-side: free = library only + `FREE_THREADS_PER_DAY` new threads (atomic `bump_usage` RPC); Pro = uploads + unlimited, toggled by the Stripe webhook.

## Project layout

```
app/               routes (library, documents, read/[id], settings, api/*)
components/reader/ Reader, TextLayer, ThreadCard, connectors + hooks
                   (useSelection, useHighlights, useThreads, useMarginLayout)
lib/               anchoring, context builder, extraction, usage, supabase clients
supabase/          migrations (schema + RLS)
scripts/           library seeder
tests/             unit tests
prototype/         the original single-file HTML prototype (pre-Supabase)
```
