export type DocumentSource = "upload" | "library";
export type DocumentKind =
  | "pdf"
  | "docx"
  | "doc"
  | "epub"
  | "mobi"
  | "txt"
  | "rtf"
  | "odt"
  | "html";
export type DocumentStatus = "processing" | "ready" | "failed";
export type Plan = "free" | "pro";
export type Role = "user" | "assistant";
export type Shelf =
  | "stoicism"
  | "economics"
  | "physics"
  | "psychology"
  | "history"
  | "founding";

export type ElementKind = "image" | "table";

export type DocumentElementRow = {
  id: string;
  document_id: string;
  kind: ElementKind;
  element_no: number;
  char_start: number;
  char_end: number;
  storage_path: string | null;
  content_text: string | null;
  caption: string | null;
};

export type HighlightColor = "amber" | "green" | "blue" | "rose";

export type DocumentRow = {
  id: string;
  owner_id: string | null;
  title: string;
  author: string | null;
  source: DocumentSource;
  file_path: string | null;
  kind: DocumentKind;
  status: DocumentStatus;
  pdf_path: string | null;
  created_at: string;
}

export type DocumentTextRow = {
  document_id: string;
  page_no: number;
  text: string;
  char_start: number;
  char_end: number;
}

export type HighlightRow = {
  id: string;
  document_id: string;
  user_id: string;
  char_start: number;
  char_end: number;
  quote: string;
  prefix: string;
  suffix: string;
  color: HighlightColor;
  created_at: string;
}

export type ThreadRow = {
  id: string;
  highlight_id: string | null;
  region_id: string | null;
  user_id: string;
  title: string | null;
  pinned: boolean;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export type DocumentAiStatus = "pending" | "ready" | "failed";

export type DocumentAiRow = {
  document_id: string;
  status: DocumentAiStatus;
  markdown: string | null;
  summary_md: string | null;
  summary_meta: DocumentAiMeta | null;
  error: string | null;
  updated_at: string;
};

/** The small structured "technical sheet" the dispatcher always sees. */
export type DocumentAiMeta = {
  doc_type: string;
  language: string;
  domain: string;
  key_entities: string[];
  structure: { title: string; page: number }[];
};

export type DocumentChunkRow = {
  id: string;
  document_id: string;
  idx: number;
  text: string;
  heading: string | null;
  char_start: number;
  char_end: number;
  page_from: number;
  page_to: number;
  /** pgvector value — sent/read as a "[...]" string via PostgREST. */
  embedding: string | null;
};

export type MessageRow = {
  id: string;
  thread_id: string;
  role: Role;
  content: string;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: string;
}

export type LibraryBookRow = {
  document_id: string;
  shelf: Shelf;
  era: string | null;
  difficulty: number | null;
  reading_minutes: number | null;
  blurb: string | null;
  sort_order: number;
}

export type RegionRow = {
  id: string;
  document_id: string;
  user_id: string;
  page_no: number;
  x: number;
  y: number;
  w: number;
  h: number;
  color: HighlightColor;
  storage_path: string | null;
  created_at: string;
};

export type UsageDailyRow = {
  user_id: string;
  day: string;
  threads_created: number;
  messages_sent: number;
}

export type ProfileRow = {
  user_id: string;
  plan: Plan;
  stripe_customer_id: string | null;
}

type TableDef<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      documents: TableDef<DocumentRow>;
      document_text: TableDef<DocumentTextRow>;
      document_elements: TableDef<DocumentElementRow>;
      highlights: TableDef<HighlightRow>;
      threads: TableDef<ThreadRow>;
      messages: TableDef<MessageRow>;
      library_books: TableDef<LibraryBookRow>;
      regions: TableDef<RegionRow>;
      usage_daily: TableDef<UsageDailyRow>;
      profiles: TableDef<ProfileRow>;
      document_ai: TableDef<DocumentAiRow>;
      document_chunks: TableDef<DocumentChunkRow>;
    };
    Views: Record<string, never>;
    Functions: {
      bump_usage: {
        Args: { p_user_id: string; p_threads: number; p_messages: number };
        Returns: UsageDailyRow;
      };
      match_chunks: {
        Args: { p_document_id: string; p_query: string; p_limit?: number };
        Returns: {
          id: string;
          idx: number;
          text: string;
          heading: string | null;
          char_start: number;
          char_end: number;
          page_from: number;
          page_to: number;
          similarity: number;
        }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

/** A highlight together with its thread and messages, as the reader consumes it. */
export type ThreadWithMessages = ThreadRow & {
  messages: MessageRow[];
};

export type HighlightWithThread = HighlightRow & {
  thread: ThreadWithMessages | null;
};

export type RegionWithThread = RegionRow & {
  thread: ThreadWithMessages | null;
};
