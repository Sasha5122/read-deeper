-- Read Deeper — initial schema
-- Apply with: supabase db push  (or run in the SQL editor)

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- documents
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users (id) on delete cascade, -- null = library item
  title text not null,
  author text,
  source text not null check (source in ('upload', 'library')),
  file_path text,
  kind text not null check (kind in ('pdf', 'docx', 'epub', 'txt')),
  status text not null default 'processing' check (status in ('processing', 'ready', 'failed')),
  created_at timestamptz not null default now()
);

create index documents_owner_idx on public.documents (owner_id);

-- ------------------------------------------------------------ document_text
-- Page-level text layer; char offsets are global across the document.
create table public.document_text (
  document_id uuid not null references public.documents (id) on delete cascade,
  page_no int not null,
  text text not null,
  char_start int not null,
  char_end int not null,
  primary key (document_id, page_no)
);

-- --------------------------------------------------------------- highlights
create table public.highlights (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  char_start int not null,
  char_end int not null check (char_end > char_start),
  quote text not null,
  prefix text not null default '',
  suffix text not null default '',
  color text not null default 'amber' check (color in ('amber', 'green', 'blue', 'rose')),
  created_at timestamptz not null default now()
);

create index highlights_doc_user_idx on public.highlights (document_id, user_id);

-- ------------------------------------------------------------------ threads
create table public.threads (
  id uuid primary key default gen_random_uuid(),
  highlight_id uuid not null unique references public.highlights (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index threads_user_idx on public.threads (user_id);

-- ----------------------------------------------------------------- messages
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  tokens_in int,
  tokens_out int,
  created_at timestamptz not null default now()
);

create index messages_thread_idx on public.messages (thread_id, created_at);

-- ------------------------------------------------------------ library_books
create table public.library_books (
  document_id uuid primary key references public.documents (id) on delete cascade,
  shelf text not null check (shelf in ('stoicism', 'economics', 'physics', 'psychology', 'history', 'founding')),
  era text,
  difficulty int check (difficulty between 1 and 5),
  reading_minutes int,
  blurb text,
  sort_order int not null default 0
);

-- -------------------------------------------------------------- usage_daily
create table public.usage_daily (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  threads_created int not null default 0,
  messages_sent int not null default 0,
  primary key (user_id, day)
);

-- ----------------------------------------------------------------- profiles
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  stripe_customer_id text
);

-- Auto-create a profile for every new auth user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep threads.updated_at fresh when messages arrive.
create or replace function public.touch_thread()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.threads set updated_at = now() where id = new.thread_id;
  return new;
end;
$$;

create trigger on_message_created
  after insert on public.messages
  for each row execute function public.touch_thread();

-- Atomic usage counter (service role only).
create or replace function public.bump_usage(p_user_id uuid, p_threads int, p_messages int)
returns public.usage_daily
language plpgsql
security definer set search_path = public
as $$
declare
  result public.usage_daily;
begin
  insert into public.usage_daily (user_id, day, threads_created, messages_sent)
  values (p_user_id, current_date, p_threads, p_messages)
  on conflict (user_id, day) do update
    set threads_created = usage_daily.threads_created + excluded.threads_created,
        messages_sent = usage_daily.messages_sent + excluded.messages_sent
  returning * into result;
  return result;
end;
$$;

revoke execute on function public.bump_usage(uuid, int, int) from public, anon, authenticated;

-- ------------------------------------------------------------------- RLS
alter table public.documents enable row level security;
alter table public.document_text enable row level security;
alter table public.highlights enable row level security;
alter table public.threads enable row level security;
alter table public.messages enable row level security;
alter table public.library_books enable row level security;
alter table public.usage_daily enable row level security;
alter table public.profiles enable row level security;

-- documents: own uploads + library visible to all signed-in users
create policy "read own or library documents" on public.documents
  for select to authenticated
  using (owner_id = auth.uid() or source = 'library');

create policy "insert own documents" on public.documents
  for insert to authenticated
  with check (owner_id = auth.uid() and source = 'upload');

create policy "update own documents" on public.documents
  for update to authenticated
  using (owner_id = auth.uid());

create policy "delete own documents" on public.documents
  for delete to authenticated
  using (owner_id = auth.uid());

-- document_text: readable when the parent document is readable
create policy "read text of readable documents" on public.document_text
  for select to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = document_id
        and (d.owner_id = auth.uid() or d.source = 'library')
    )
  );

-- highlights / threads: own rows only
create policy "own highlights" on public.highlights
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "own threads" on public.threads
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- messages: through thread ownership
create policy "own messages" on public.messages
  for all to authenticated
  using (
    exists (select 1 from public.threads t where t.id = thread_id and t.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.threads t where t.id = thread_id and t.user_id = auth.uid())
  );

-- library shelf metadata: readable by all signed-in users
create policy "read library books" on public.library_books
  for select to authenticated
  using (true);

-- usage: user can see their own counters (writes go through bump_usage)
create policy "read own usage" on public.usage_daily
  for select to authenticated
  using (user_id = auth.uid());

-- profiles: user reads their own plan (writes via service role / webhook)
create policy "read own profile" on public.profiles
  for select to authenticated
  using (user_id = auth.uid());

-- ------------------------------------------------------------------ storage
insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', false)
on conflict (id) do nothing;

create policy "users upload to own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "users read own uploads" on storage.objects
  for select to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "users delete own uploads" on storage.objects
  for delete to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);
