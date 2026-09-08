import { z } from "zod";
import { ApiError, handleErrors } from "@/lib/api";
import { resolveAnchor } from "@/lib/anchoring";
import { aiText } from "@/lib/ai";
import { QUICK_ACTIONS, SURROUNDING_CHARS } from "@/lib/context";
import { BUTTON_TICKETS, dispatch, type RoutingTicket } from "@/lib/dispatcher";
import { executeTicket, retrieveChunks, type ExecutorInput } from "@/lib/executor";
import { getDocumentWithPages } from "@/lib/docs";
import { pageForOffset } from "@/lib/extract";
import { env } from "@/lib/env";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/supabase/server";
import { recordUsage } from "@/lib/usage";
import type { Role } from "@/lib/types";

export const maxDuration = 120;

const SendMessage = z
  .object({
    content: z.string().trim().min(1).max(4000).optional(),
    action: z.enum(["explain_simpler", "give_example"]).optional(),
    /** Save the text as a private note on the thread — no AI call. */
    noteOnly: z.boolean().optional(),
  })
  .refine((v) => v.content || v.action, { message: "content or action is required" });

/**
 * Append a user message to a thread and stream the AI reply as plain text.
 * Free-text questions go through the dispatcher (routing ticket: tier + dosed
 * context); quick-action buttons carry fixed tickets. The thread stays
 * isolated: quote + dosed surroundings + own history — never other threads.
 */
export const POST = handleErrors(
  async (request: Request, ctx: { params: Promise<{ threadId: string }> }) => {
    const { supabase, user } = await requireUser();
    const { threadId } = z.object({ threadId: z.string().uuid() }).parse(await ctx.params);
    const body = SendMessage.parse(await request.json());
    const question = body.content ?? QUICK_ACTIONS[body.action!];

    // RLS restricts these reads to the caller's own rows.
    const { data: thread } = await supabase
      .from("threads")
      .select("*")
      .eq("id", threadId)
      .maybeSingle();
    if (!thread) throw new ApiError(404, "Thread not found");

    // A note: persist the reader's text on the thread and stop — no AI.
    if (body.noteOnly && body.content) {
      const { data: note, error: noteErr } = await supabase
        .from("messages")
        .insert({ thread_id: threadId, role: "user", content: body.content })
        .select("*")
        .single();
      if (noteErr || !note) throw new ApiError(500, noteErr?.message ?? "Could not save note");
      if (!thread.title) {
        await supabase.from("threads").update({ title: body.content.slice(0, 80) }).eq("id", threadId);
      }
      return Response.json({ message: note });
    }

    // Fail clearly (and before saving anything) when AI is not configured —
    // highlights, captures and notes keep working without it.
    if (!env.hasOpenAI) {
      throw new ApiError(
        503,
        "AI is not connected yet — add OPENAI_API_KEY to .env.local and restart. Highlights, captures and notes work without it.",
      );
    }

    /* ---- resolve the anchor: text highlight or captured region ---- */
    let documentId: string;
    let quote: string;
    let anchorStart = 0;
    let anchorEnd = 0;
    let pageNo = 1;
    let fullText = "";
    let docInfo: { title: string; author: string | null };
    let imageDataUrl: string | null = null;

    const admin = createSupabaseAdmin();

    if (thread.region_id) {
      const { data: region } = await supabase
        .from("regions")
        .select("*")
        .eq("id", thread.region_id)
        .maybeSingle();
      if (!region) throw new ApiError(404, "Region not found");
      const { document, pages } = await getDocumentWithPages(supabase, region.document_id);
      documentId = region.document_id;
      docInfo = { title: document.title, author: document.author };
      pageNo = region.page_no;
      quote = `Captured image area on page ${region.page_no}`;
      const page = pages.find((p) => p.page_no === region.page_no) ?? pages[0];
      fullText = pages.map((p) => p.text).join("");
      anchorStart = page?.char_start ?? 0;
      anchorEnd = Math.min(anchorStart + 400, page?.char_end ?? anchorStart);
      // Vision: attach the captured pixels (base64 — the API cannot reach localhost URLs).
      if (region.storage_path) {
        const { data: blob } = await admin.storage.from("elements").download(region.storage_path);
        if (blob) {
          const buf = Buffer.from(await blob.arrayBuffer());
          imageDataUrl = `data:image/png;base64,${buf.toString("base64")}`;
        }
      }
    } else {
      const { data: highlight } = await supabase
        .from("highlights")
        .select("*")
        .eq("id", thread.highlight_id!)
        .maybeSingle();
      if (!highlight) throw new ApiError(404, "Highlight not found");
      const { document, pages, fullText: ft } = await getDocumentWithPages(
        supabase,
        highlight.document_id,
      );
      documentId = highlight.document_id;
      docInfo = { title: document.title, author: document.author };
      fullText = ft;
      const resolved = resolveAnchor(fullText, highlight);
      anchorStart = resolved?.start ?? highlight.char_start;
      anchorEnd = resolved?.end ?? highlight.char_end;
      pageNo = pageForOffset(pages, anchorStart)?.page_no ?? 1;
      quote = highlight.quote;

      // A highlight may anchor a non-text element placeholder: describe the
      // element itself (table contents) instead of the bare placeholder.
      const { data: element } = await supabase
        .from("document_elements")
        .select("*")
        .eq("document_id", documentId)
        .eq("char_start", anchorStart)
        .maybeSingle();
      if (element) {
        quote =
          element.kind === "table"
            ? `Table ${element.element_no} from the document. Its contents (cells separated by |):\n${element.content_text ?? ""}`
            : `Image/figure ${element.element_no} from the document.`;
      }
    }

    /* ---- history + AI layer (summary/meta) ---- */
    const [{ data: historyRows }, { data: docAi }] = await Promise.all([
      supabase.from("messages").select("*").eq("thread_id", threadId).order("created_at", { ascending: true }),
      supabase.from("document_ai").select("*").eq("document_id", documentId).maybeSingle(),
    ]);
    const history = (historyRows ?? []).map((m) => ({ role: m.role as Role, content: m.content }));
    const meta = docAi?.status === "ready" ? docAi.summary_meta : null;
    const summaryMd = docAi?.status === "ready" ? docAi.summary_md : null;

    /* ---- routing ticket: fixed for buttons, dispatched for free text ---- */
    const hasAssistantAnswer = history.some((m) => m.role === "assistant");
    let ticket: RoutingTicket;
    if (body.action) {
      ticket = { ...BUTTON_TICKETS[body.action] };
      // Deterministic cascade: "Explain" pressed again after an answer means
      // the previous tier failed — escalate to the heavy model, plain language.
      if (body.action === "explain_simpler" && hasAssistantAnswer) {
        ticket.tier = "document";
        ticket.register = "plain";
      }
    } else {
      const res = await dispatch({
        question,
        quote,
        docTitle: docInfo.title,
        meta,
        historyCount: history.length,
        isRegion: !!thread.region_id,
        recentUserMessages: history
          .filter((m) => m.role === "user")
          .slice(-3)
          .map((m) => m.content),
      });
      ticket = res.ticket;
    }
    console.log(
      `[route] thread=${threadId.slice(0, 8)} tier=${ticket.tier} surround=${ticket.surrounding} conv=${ticket.conversation} rag=${ticket.rag_chunks} web=${ticket.web}`,
    );

    /* ---- assemble exactly the context the ticket prescribes ---- */
    const surround = imageDataUrl ? SURROUNDING_CHARS : ticket.surrounding;
    const before = surround > 0 ? fullText.slice(Math.max(0, anchorStart - surround), anchorStart) : "";
    const after = surround > 0 ? fullText.slice(anchorEnd, anchorEnd + surround) : "";
    const ragChunks = await retrieveChunks(documentId, question, ticket.rag_chunks);

    const execInput: ExecutorInput = {
      ticket,
      question,
      quote,
      before,
      after,
      pageNo,
      docTitle: docInfo.title,
      docAuthor: docInfo.author,
      meta,
      summaryMd,
      threadSummary: thread.summary,
      history,
      ragChunks,
      imageDataUrl,
    };

    const { error: insertErr } = await supabase
      .from("messages")
      .insert({ thread_id: threadId, role: "user", content: question });
    if (insertErr) throw new ApiError(500, insertErr.message);
    if (!thread.title) {
      await supabase.from("threads").update({ title: question.slice(0, 80) }).eq("id", threadId);
    }

    /* ---- stream ---- */
    const encoder = new TextEncoder();
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const { text, usage } = await executeTicket(execInput, (delta) =>
            controller.enqueue(encoder.encode(delta)),
          );
          await supabase.from("messages").insert({
            thread_id: threadId,
            role: "assistant",
            content: text,
            tokens_in: usage.inputTokens,
            tokens_out: usage.outputTokens,
          });
          await recordUsage(user.id, 0, 1);
          controller.close();

          // Rolling thread summary: keep long conversations cheap and sharp.
          const total = history.length + 2;
          if (total >= 6 && total % 4 === 0) {
            void updateThreadSummary(threadId, [
              ...history,
              { role: "user", content: question },
              { role: "assistant", content: text },
            ]);
          }
        } catch (err) {
          console.error("thread stream failed", err);
          controller.error(err);
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  },
);

async function updateThreadSummary(
  threadId: string,
  history: { role: Role; content: string }[],
): Promise<void> {
  try {
    const transcript = history
      .map((m) => `${m.role === "user" ? "Reader" : "AI"}: ${m.content}`)
      .join("\n")
      .slice(-12000);
    const { text } = await aiText({
      model: env.modelDispatcher,
      system:
        "Summarise this margin conversation in 2-3 dense sentences, in its own language: what the reader wanted, what was established, any open thread. No preamble.",
      input: transcript,
      effort: "minimal",
      maxOutputTokens: 800,
    });
    if (text.trim()) {
      const admin = createSupabaseAdmin();
      await admin.from("threads").update({ summary: text.trim() }).eq("id", threadId);
    }
  } catch (err) {
    console.error("thread summary update failed", err);
  }
}
