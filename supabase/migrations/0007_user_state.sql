-- Entry-point behaviour: the app opens straight into the reader, on the last
-- document the user had open.

create table public.user_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  last_document_id uuid references public.documents (id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.user_state enable row level security;

create policy "own user_state" on public.user_state
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
