-- AI preparation layer: markdown copy, summary, RAG chunks with embeddings,
-- rolling per-thread conversation summaries.

create extension if not exists vector;

-- One row per document: the AI-facing representation.
create table public.document_ai (
  document_id uuid primary key references public.documents (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  markdown text,
  summary_md text,
  summary_meta jsonb,
  error text,
  updated_at timestamptz not null default now()
);

alter table public.document_ai enable row level security;

create policy "read ai layer of readable documents" on public.document_ai
  for select to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = document_id and (d.owner_id = auth.uid() or d.source = 'library')
    )
  );

-- Retrieval chunks. char_start/char_end are global offsets into the document
-- full text (the same coordinate system highlights use).
create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  idx int not null,
  text text not null,
  heading text,
  char_start int not null,
  char_end int not null,
  page_from int not null,
  page_to int not null,
  embedding vector(1536),
  unique (document_id, idx)
);

create index document_chunks_document_idx on public.document_chunks (document_id);
create index document_chunks_embedding_idx on public.document_chunks
  using hnsw (embedding vector_cosine_ops);

alter table public.document_chunks enable row level security;

create policy "read chunks of readable documents" on public.document_chunks
  for select to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = document_id and (d.owner_id = auth.uid() or d.source = 'library')
    )
  );

-- Vector search inside one document (called with the service role).
create or replace function public.match_chunks(
  p_document_id uuid,
  p_query vector(1536),
  p_limit int default 6
)
returns table (
  id uuid,
  idx int,
  text text,
  heading text,
  char_start int,
  char_end int,
  page_from int,
  page_to int,
  similarity float
)
language sql stable as $$
  select c.id, c.idx, c.text, c.heading, c.char_start, c.char_end,
         c.page_from, c.page_to,
         1 - (c.embedding <=> p_query) as similarity
  from public.document_chunks c
  where c.document_id = p_document_id and c.embedding is not null
  order by c.embedding <=> p_query
  limit p_limit;
$$;

-- Rolling conversation summary, maintained by the cheap model.
alter table public.threads add column summary text;
