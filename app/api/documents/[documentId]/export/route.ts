import { z } from "zod";
import { ApiError, handleErrors } from "@/lib/api";
import { threadsToMarkdown, type ExportThread } from "@/lib/markdown-export";
import { requireUser } from "@/lib/supabase/server";

/** Export every thread on a document as a Markdown study sheet. */
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

    const { data: highlights } = await supabase
      .from("highlights")
      .select("*")
      .eq("document_id", documentId)
      .order("char_start", { ascending: true });

    const items: ExportThread[] = [];
    for (const highlight of highlights ?? []) {
      const { data: thread } = await supabase
        .from("threads")
        .select("*")
        .eq("highlight_id", highlight.id)
        .maybeSingle();
      if (!thread) continue;
      const { data: messages } = await supabase
        .from("messages")
        .select("*")
        .eq("thread_id", thread.id)
        .order("created_at", { ascending: true });
      items.push({ highlight, thread, messages: messages ?? [] });
    }

    const markdown = threadsToMarkdown(document.title, document.author, items);
    const filename = `${document.title.replace(/[^\w\- ]+/g, "").slice(0, 60) || "threads"}.md`;
    return new Response(markdown, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  },
);
