-- Universal capture tool: a rectangle drawn over the document becomes a
-- persistent region (its pixels stored as an image) with its own chat thread.

create table public.regions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  page_no int not null,
  -- rectangle in scale-1 page units (crop/zoom independent)
  x real not null,
  y real not null,
  w real not null check (w > 0),
  h real not null check (h > 0),
  color text not null default 'amber' check (color in ('amber', 'green', 'blue', 'rose')),
  storage_path text, -- captured PNG in the public 'elements' bucket
  created_at timestamptz not null default now()
);

create index regions_doc_user_idx on public.regions (document_id, user_id);

alter table public.regions enable row level security;
create policy "own regions" on public.regions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- a thread anchors to EITHER a text highlight OR a captured region
alter table public.threads alter column highlight_id drop not null;
alter table public.threads add column region_id uuid unique references public.regions (id) on delete cascade;
alter table public.threads add constraint threads_anchor_check
  check (num_nonnulls(highlight_id, region_id) = 1);
