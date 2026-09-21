import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError, handleErrors } from "@/lib/api";
import { resolveAnchor } from "@/lib/anchoring";
import { aiText } from "@/lib/ai";
import {
  answerHeader,
  docTokenCount,
  documentBlock,
  logAnswer,
  oversizedContext,
  planRequest,
  streamAnswer,
  type AnswerInput,
} from "@/lib/answer";
import { QUICK_ACTIONS } from "@/lib/context";
import { getDocumentWithPages } from "@/lib/docs";
import { pageForOffset } from "@/lib/extract";
import { env } from "@/lib/env";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/supabase/server";
import { recordUsage } from "@/lib/usage";
import type { Role } from "@/lib/types";

export const maxDuration = 300;

const SendMessage = z
  .object({
    content: z.string().trim().min(1).max(4000).optional(),
    action: z.enum(["explain_simpler", "give_example"]).optional(),
    /** Save the text as a private note on the thread — no AI call. */
    noteOnly: z.boolean().optional(),
  })
  .refine((v) => v.content || v.action, { message: "content or action is required" });

/**
 * V2 pipeline: one strong model, the FULL document in context (page markers),
 * the full thread history, reasoning on, streamed. Only oversized documents
 * fall back to RAG. Quick actions are ordinary questions — same path.
 */
export const POST = handleErrors(
  async (request: Request, ctx: { params: Promise<{ threadId: string }> }) => {
    const { supabase, user } = await requireUser();
    const { threadId } = z.object({ threadId: z.string().uuid() }).parse(await ctx.params);
    const body = SendMessage.parse(await request.json());
    const question = body.content ?? QUICK_ACTIONS[body.action!];

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

    if (!env.hasOpenAI) {
      throw new ApiError(
        503,
        "AI is not connected yet — add OPENAI_API_KEY to .env.local and restart. Highlights, captures and notes work without it.",
      );
    }

    /* ---- anchor: text highlight or captured region ---- */
    const admin = createSupabaseAdmin();
    let documentId: string;
    let passageBlock: string;
    let pageNo = 1;
    let imageDataUrl: string | null = null;

    let docHandle: Awaited<ReturnType<typeof getDocumentWithPages>>;
    if (thread.region_id) {
      const { data: region } = await supabase
        .from("regions")
        .select("*")
        .eq("id", thread.region_id)
        .maybeSingle();
      if (!region) throw new ApiError(404, "Region not found");
      documentId = region.document_id;
      docHandle = await getDocumentWithPages(supabase, documentId);
      pageNo = region.page_no;
      passageBlock = `The reader captured an image region on page ${region.page_no} (a chart, table, figure or formula — the image is attached to their message).`;
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
      documentId = highlight.document_id;
      docHandle = await getDocumentWithPages(supabase, documentId);
      const resolved = resolveAnchor(docHandle.fullText, highlight);
      const start = resolved?.start ?? highlight.char_start;
      pageNo = pageForOffset(docHandle.pages, start)?.page_no ?? 1;

      let quote = highlight.quote;
      const { data: element } = await supabase
        .from("document_elements")
        .select("*")
        .eq("document_id", documentId)
        .eq("char_start", start)
        .maybeSingle();
      if (element) {
        quote =
          element.kind === "table"
            ? `Table ${element.element_no}. Contents (cells separated by |):\n${element.content_text ?? ""}`
            : `Image/figure ${element.element_no} from the document.`;
      }
      passageBlock = `The reader highlighted this passage on page ${pageNo}:\n<passage>${quote}</passage>`;
    }
    const { document, pages } = docHandle;

    /* ---- history (full; >40 messages compress the oldest 20, once) ---- */
    const [{ data: historyRows }, { data: docAi }] = await Promise.all([
      supabase.from("messages").select("*").eq("thread_id", threadId).order("created_at", { ascending: true }),
      supabase.from("document_ai").select("*").eq("document_id", documentId).maybeSingle(),
    ]);
    let history = (historyRows ?? []).map((m) => ({ role: m.role as Role, content: m.content }));
    if (history.length > 40) {
      let summary = thread.summary;
      if (!summary) {
        const { text } = await aiText({
          model: env.modelAnswer,
          system: "Summarise these conversation messages faithfully and densely, keeping every established fact and open question.",
          input: history.slice(0, 20).map((m) => `${m.role}: ${m.content}`).join("\n"),
          effort: "low",
          maxOutputTokens: 3000,
        });
        summary = text.trim();
        await admin.from("threads").update({ summary }).eq("id", threadId);
      }
      history = [
        { role: "assistant", content: `(Summary of the first 20 messages of this thread: ${summary})` },
        ...history.slice(20),
      ];
    }

    /* ---- context branch: full document vs oversized RAG ---- */
    const docTokens = docTokenCount(pages);
    const meta = docAi?.status === "ready" ? docAi.summary_meta : null;
    const header = answerHeader(document, meta);
    const full = docTokens <= env.docFullContextMaxTokens;

    const [plan, oversized] = await Promise.all([
      planRequest(question, document.title),
      full
        ? Promise.resolve(undefined)
        : oversizedContext(documentId, question, pages, pageNo, docAi?.summary_md ?? null),
    ]);

    const input: AnswerInput = {
      question,
      web: plan.web,
      effort: plan.effort,
      verbosity: plan.verbosity,
      cacheKey: documentId,
      // markdown gated on status EXACTLY like the warm route — any asymmetry
      // makes the answer prefix diverge from the warmed one (measured live:
      // warm used the pages fallback, the answer used fresh markdown → 0%).
      docBlock: full
        ? documentBlock(pages, docAi?.status === "ready" ? docAi.markdown : null, header)
        : null,
      oversized,
      passageBlock,
      history,
      imageDataUrl,
    };

    // Temporary cache diagnosis: compare byte-identity with the warm route.
    if (input.docBlock) {
      console.log(
        `[prefix] doc=${documentId.slice(0, 8)} key=${input.cacheKey?.slice(0, 8)} ` +
          `docHash=${createHash("sha256").update(input.docBlock).digest("hex").slice(0, 16)} len=${input.docBlock.length}`,
      );
    }

    const { error: insertErr } = await supabase
      .from("messages")
      .insert({ thread_id: threadId, role: "user", content: question });
    if (insertErr) throw new ApiError(500, insertErr.message);
    if (!thread.title) {
      await supabase.from("threads").update({ title: question.slice(0, 80) }).eq("id", threadId);
    }

    /* ---- stream ---- */
    // Abort plumbing (client Stop): the aborted fetch surfaces here both on
    // request.signal and as cancel() of the ReadableStream (which one fires
    // first varies by runtime) — either path aborts the OpenAI stream, which
    // stops token generation, and streamAnswer RESOLVES with the partial text
    // so the normal completion path below saves it. Nothing streamed is lost.
    const upstream = new AbortController();
    const onReqAbort = () => upstream.abort();
    if (request.signal.aborted) upstream.abort();
    else request.signal.addEventListener("abort", onReqAbort, { once: true });

    const encoder = new TextEncoder();
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        // After an abort the controller is cancelled — enqueue/close throw.
        const enqueue = (delta: string) => {
          try {
            controller.enqueue(encoder.encode(delta));
          } catch {
            /* client gone — keep streaming server-side into result.text */
          }
        };
        try {
          const result = await streamAnswer(input, enqueue, upstream.signal);
          logAnswer(user.id, result, { web: plan.web, docTokens, branch: full ? "full" : "rag" });
          // On abort with zero text streamed there is no assistant message to
          // keep — skip the empty insert so the thread just shows the question.
          if (result.text.length > 0) {
            await supabase.from("messages").insert({
              thread_id: threadId,
              role: "assistant",
              content: result.text,
              tokens_in: result.usage.inputTokens,
              tokens_out: result.usage.outputTokens,
            });
          }
          await recordUsage(user.id, 0, 1);
          try {
            controller.close();
          } catch {
            /* already cancelled by the abort */
          }
        } catch (err) {
          console.error("thread stream failed", err);
          try {
            controller.error(err);
          } catch {
            /* already cancelled */
          }
        } finally {
          request.signal.removeEventListener("abort", onReqAbort);
        }
      },
      cancel() {
        upstream.abort();
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
