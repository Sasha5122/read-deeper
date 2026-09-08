-- Faithful display: office-family documents are converted to PDF once at
-- processing time; the reader renders the original PDF pages for both.
alter table public.documents add column if not exists pdf_path text;

-- Existing PDFs display their own file.
update public.documents set pdf_path = file_path where kind = 'pdf' and pdf_path is null;
