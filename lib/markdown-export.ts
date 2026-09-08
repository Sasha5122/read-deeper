import type { HighlightRow, MessageRow, ThreadRow } from "@/lib/types";

export interface ExportThread {
  highlight: HighlightRow;
  thread: ThreadRow;
  messages: MessageRow[];
}

/** Export a document's threads as a readable Markdown study sheet. */
export function threadsToMarkdown(
  documentTitle: string,
  documentAuthor: string | null,
  items: ExportThread[],
): string {
  const lines: string[] = [
    `# ${documentTitle}`,
    documentAuthor ? `*${documentAuthor}*` : "",
    "",
    `Exported from Read Deeper — ${items.length} thread${items.length === 1 ? "" : "s"}.`,
    "",
  ];

  const sorted = [...items].sort((a, b) => a.highlight.char_start - b.highlight.char_start);
  for (const { highlight, thread, messages } of sorted) {
    lines.push("---", "", `## ${thread.title ?? "Untitled thread"}`, "");
    lines.push(`> ${highlight.quote.replace(/\n/g, "\n> ")}`, "");
    for (const m of messages) {
      lines.push(m.role === "user" ? `**You:** ${m.content}` : `**Claude:** ${m.content}`, "");
    }
  }
  return lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");
}
