import { NextResponse } from "next/server";
import { handleErrors } from "@/lib/api";
import { requireUser } from "@/lib/supabase/server";

export interface RecentSession {
  documentId: string;
  title: string;
  author: string | null;
  status: string;
  threadCount: number;
  lastActivity: string;
}

/**
 * The user's sessions: every document they have worked on (highlights/chats)
 * plus their own uploads, newest activity first.
 */
export const GET = handleErrors(async () => {
  const { supabase, user } = await requireUser();

  const [{ data: highlights }, { data: threads }, { data: ownDocs }] = await Promise.all([
    supabase.from("highlights").select("id, document_id, created_at").eq("user_id", user.id),
    supabase.from("threads").select("highlight_id, updated_at").eq("user_id", user.id),
    supabase.from("documents").select("*").eq("owner_id", user.id),
  ]);

  const threadByHighlight = new Map((threads ?? []).map((t) => [t.highlight_id, t]));
  const perDoc = new Map<string, { threadCount: number; lastActivity: string }>();

  for (const h of highlights ?? []) {
    const entry = perDoc.get(h.document_id) ?? { threadCount: 0, lastActivity: h.created_at };
    const thread = threadByHighlight.get(h.id);
    entry.threadCount += 1;
    const activity = thread?.updated_at ?? h.created_at;
    if (activity > entry.lastActivity) entry.lastActivity = activity;
    perDoc.set(h.document_id, entry);
  }
  for (const d of ownDocs ?? []) {
    if (!perDoc.has(d.id)) perDoc.set(d.id, { threadCount: 0, lastActivity: d.created_at });
  }

  const ids = Array.from(perDoc.keys());
  if (ids.length === 0) return NextResponse.json({ sessions: [] });

  const { data: docs } = await supabase.from("documents").select("*").in("id", ids);
  const sessions: RecentSession[] = (docs ?? [])
    .map((d) => ({
      documentId: d.id,
      title: d.title,
      author: d.author,
      status: d.status,
      threadCount: perDoc.get(d.id)!.threadCount,
      lastActivity: perDoc.get(d.id)!.lastActivity,
    }))
    .sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1))
    .slice(0, 30);

  return NextResponse.json({ sessions });
});
