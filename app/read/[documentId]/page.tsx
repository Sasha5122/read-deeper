import { notFound } from "next/navigation";
import { Reader } from "@/components/reader/Reader";
import { prepareDocumentAi } from "@/lib/aiprep";
import { requireUser } from "@/lib/supabase/server";
import { getPlan } from "@/lib/usage";
import { env } from "@/lib/env";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import type { HighlightWithThread, MessageRow, RegionWithThread, ThreadRow } from "@/lib/types";

export default async function ReadPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const { documentId } = await params;
  const { supabase, user } = await requireUser();
  const plan = await getPlan(user.id);

  const { data: document } = await supabase
    .from("documents")
    .select("*")
    .eq("id", documentId)
    .maybeSingle();
  if (!document || document.status !== "ready") notFound();

  // Remember this as the user's last-open document — the app's entry point
  // ("/") drops them straight back here, ChatGPT-style.
  await supabase
    .from("user_state")
    .upsert({ user_id: user.id, last_document_id: documentId, updated_at: new Date().toISOString() });

  const { data: pages } = await supabase
    .from("document_text")
    .select("*")
    .eq("document_id", documentId)
    .order("page_no", { ascending: true });

  const { data: elementRows } = await supabase
    .from("document_elements")
    .select("*")
    .eq("document_id", documentId)
    .order("char_start", { ascending: true });
  const elements = (elementRows ?? []).map((el) => ({
    id: el.id,
    kind: el.kind,
    element_no: el.element_no,
    char_start: el.char_start,
    char_end: el.char_end,
    url: el.storage_path
      ? `${env.supabaseUrl}/storage/v1/object/public/elements/${el.storage_path}`
      : null,
    content_text: el.content_text,
  }));

  const { data: highlights } = await supabase
    .from("highlights")
    .select("*")
    .eq("document_id", documentId)
    .eq("user_id", user.id)
    .order("char_start", { ascending: true });

  const { data: regionRows } = await supabase
    .from("regions")
    .select("*")
    .eq("document_id", documentId)
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });
  const regionIds = (regionRows ?? []).map((r) => r.id);
  let regionThreads: ThreadRow[] = [];
  let regionMessages: MessageRow[] = [];
  if (regionIds.length > 0) {
    const { data: t } = await supabase.from("threads").select("*").in("region_id", regionIds);
    regionThreads = t ?? [];
    const tIds = regionThreads.map((x) => x.id);
    if (tIds.length > 0) {
      const { data: m } = await supabase
        .from("messages")
        .select("*")
        .in("thread_id", tIds)
        .order("created_at", { ascending: true });
      regionMessages = m ?? [];
    }
  }
  const regionThreadByRegion = new Map(regionThreads.map((t) => [t.region_id, t]));
  const regionMsgsByThread = new Map<string, MessageRow[]>();
  for (const m of regionMessages) {
    const list = regionMsgsByThread.get(m.thread_id) ?? [];
    list.push(m);
    regionMsgsByThread.set(m.thread_id, list);
  }
  const initialRegions: RegionWithThread[] = (regionRows ?? []).map((r) => {
    const t = regionThreadByRegion.get(r.id) ?? null;
    return { ...r, thread: t ? { ...t, messages: regionMsgsByThread.get(t.id) ?? [] } : null };
  });

  const highlightIds = (highlights ?? []).map((h) => h.id);
  let threads: ThreadRow[] = [];
  let messages: MessageRow[] = [];
  if (highlightIds.length > 0) {
    const { data: threadRows } = await supabase
      .from("threads")
      .select("*")
      .in("highlight_id", highlightIds);
    threads = threadRows ?? [];
    const threadIds = threads.map((t) => t.id);
    if (threadIds.length > 0) {
      const { data: messageRows } = await supabase
        .from("messages")
        .select("*")
        .in("thread_id", threadIds)
        .order("created_at", { ascending: true });
      messages = messageRows ?? [];
    }
  }

  const threadByHighlight = new Map(threads.map((t) => [t.highlight_id, t]));
  const messagesByThread = new Map<string, MessageRow[]>();
  for (const m of messages) {
    const list = messagesByThread.get(m.thread_id) ?? [];
    list.push(m);
    messagesByThread.set(m.thread_id, list);
  }

  const initialHighlights: HighlightWithThread[] = (highlights ?? []).map((h) => {
    const thread = threadByHighlight.get(h.id) ?? null;
    return {
      ...h,
      thread: thread ? { ...thread, messages: messagesByThread.get(thread.id) ?? [] } : null,
    };
  });

  // AI prep can die silently (instance reaped mid-run) leaving pending/failed
  // forever — answers then silently degrade to the pages fallback. Self-heal:
  // opening the document re-fires the preparation when it's been stuck >2 min.
  const { data: docAi } = await supabase
    .from("document_ai")
    .select("status, updated_at")
    .eq("document_id", documentId)
    .maybeSingle();
  const aiPrepStatus = docAi?.status ?? null;
  const stuckSince = docAi?.updated_at ? Date.now() - new Date(docAi.updated_at).getTime() : Infinity;
  if (aiPrepStatus !== "ready" && stuckSince > 2 * 60 * 1000) {
    void prepareDocumentAi(documentId).catch((e) => console.error("aiprep retry failed:", e));
  }

  let pdfUrl: string | null = null;
  if (document.pdf_path) {
    const admin = createSupabaseAdmin();
    const { data: signed } = await admin.storage
      .from("uploads")
      .createSignedUrl(document.pdf_path, 3600);
    pdfUrl = signed?.signedUrl ?? null;
  }

  return (
    <Reader
      document={document}
      pages={pages ?? []}
      initialHighlights={initialHighlights}
      elements={elements}
      initialRegions={initialRegions}
      pdfUrl={pdfUrl}
      userId={user.id}
      plan={plan}
      aiPrepStatus={aiPrepStatus}
    />
  );
}
