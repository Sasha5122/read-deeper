import { z } from "zod";
import { ApiError, handleErrors } from "@/lib/api";
import { requireUser } from "@/lib/supabase/server";
import type { MessageRow, ThreadRow } from "@/lib/types";

/**
 * Export every thread on a document — highlight threads AND capture (region)
 * threads — as one Markdown study sheet in document order. A region's
 * position is approximated as its page's char_start + its y offset, the same
 * sort key the reader's regionItems uses, so the export order matches the
 * margin order.
 */
export const GET = handleErrors(
  async (_request: Request, ctx: { params: Promise<{ documentId: string }> }) => {
    const { supabase } = await requireUser();
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(await ctx.params);

    const { data: document } = await supabase
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .maybeSingle();
    if (!document) throw new ApiError(404, "Document not found");

    const [{ data: highlights }, { data: regions }, { data: pages }] = await Promise.all([
      supabase
        .from("highlights")
        .select("*")
        .eq("document_id", documentId)
        .order("char_start", { ascending: true }),
      supabase
        .from("regions")
        .select("*")
        .eq("document_id", documentId)
        .order("page_no", { ascending: true })
        .order("y", { ascending: true }),
      supabase
        .from("document_text")
        .select("page_no, char_start")
        .eq("document_id", documentId)
        .order("page_no", { ascending: true }),
    ]);
    const pageStartByNo = new Map((pages ?? []).map((p) => [p.page_no, p.char_start]));

    const messagesOf = async (thread: ThreadRow): Promise<MessageRow[]> => {
      const { data: messages } = await supabase
        .from("messages")
        .select("*")
        .eq("thread_id", thread.id)
        .order("created_at", { ascending: true });
      return messages ?? [];
    };

    // One merged stream in document order: highlights by char_start, regions
    // by page char_start + y (consistent with the reader's regionItems).
    interface ExportItem {
      sortKey: number;
      lines: string[];
    }
    const items: ExportItem[] = [];

    for (const highlight of highlights ?? []) {
      const { data: thread } = await supabase
        .from("threads")
        .select("*")
        .eq("highlight_id", highlight.id)
        .maybeSingle();
      if (!thread) continue;
      const messages = await messagesOf(thread);
      const lines = [
        "---",
        "",
        `## ${thread.title ?? "Untitled thread"}`,
        "",
        `> ${highlight.quote.replace(/\n/g, "\n> ")}`,
        "",
      ];
      for (const m of messages) {
        lines.push(m.role === "user" ? `**You:** ${m.content}` : `**Claude:** ${m.content}`, "");
      }
      items.push({ sortKey: highlight.char_start, lines });
    }

    for (const region of regions ?? []) {
      const { data: thread } = await supabase
        .from("threads")
        .select("*")
        .eq("region_id", region.id)
        .maybeSingle();
      if (!thread) continue;
      const messages = await messagesOf(thread);
      const lines = ["---", "", `### [Captured area — page ${region.page_no}]`, ""];
      for (const m of messages) {
        lines.push(m.role === "user" ? `**You:** ${m.content}` : `**Claude:** ${m.content}`, "");
      }
      const pageStart = pageStartByNo.get(region.page_no) ?? 0;
      items.push({ sortKey: pageStart + Math.max(0, Math.round(region.y)), lines });
    }

    items.sort((a, b) => a.sortKey - b.sortKey);

    const lines: string[] = [
      `# ${document.title}`,
      document.author ? `*${document.author}*` : "",
      "",
      `Exported from Read Deeper — ${items.length} thread${items.length === 1 ? "" : "s"}.`,
      "",
      ...items.flatMap((i) => i.lines),
    ];
    const markdown = lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");

    const filename = `${document.title.replace(/[^\w\- ]+/g, "").slice(0, 60) || "threads"}.md`;
    return new Response(markdown, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  },
);
