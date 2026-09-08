-- Widen supported document kinds: old Word, ebooks, RTF, ODT, HTML.
alter table public.documents drop constraint documents_kind_check;
alter table public.documents add constraint documents_kind_check
  check (kind in ('pdf', 'docx', 'doc', 'epub', 'mobi', 'txt', 'rtf', 'odt', 'html'));
