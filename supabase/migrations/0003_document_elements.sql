-- Non-text elements (images, tables, figures) extracted from documents.
-- Each element owns a placeholder range in the document's text layer, so
-- highlights/threads anchor to elements exactly like they anchor to text.

create table public.document_elements (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  kind text not null check (kind in ('image', 'table')),
  element_no int not null,
  char_start int not null,
  char_end int not null check (char_end > char_start),
  storage_path text,      -- images: path inside the 'elements' bucket
  content_text text,      -- tables: plain-text rows ("a | b | c" per line)
  caption text,
  unique (document_id, kind, element_no)
);

create index document_elements_doc_idx on public.document_elements (document_id, char_start);

alter table public.document_elements enable row level security;

create policy "read elements of readable documents" on public.document_elements
  for select to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = document_id
        and (d.owner_id = auth.uid() or d.source = 'library')
    )
  );

-- Extracted images live in a public bucket (derived content, random uuid paths);
-- only the service role writes to it.
insert into storage.buckets (id, name, public)
values ('elements', 'elements', true)
on conflict (id) do nothing;
