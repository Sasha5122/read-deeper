import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServer } from "@/lib/supabase/server";

export const maxDuration = 60;

/**
 * Recruiter demo link: every visit creates a THROWAWAY account with its own
 * private copy of the master demo document (the zebra article), signs the
 * browser in without any form, and lands straight in the reader. Visitors
 * never intersect â€” each gets their own workspace. Accounts older than
 * DEMO_TTL_H are reaped opportunistically on later visits.
 *
 * Master safety: the master document lives in its own account nobody signs
 * into. The clone gets its OWN copies of the storage objects (file/pdf), so
 * a visitor deleting their doc can never touch the master's files. Element
 * images stay shared (they are read-only public paths; the clone's delete
 * only lists elements/<cloneId>/, which doesn't exist).
 */
const DEMO_DOMAIN = "readdeeper.demo";
// The master account lives on the demo domain too — the reaper must NEVER
// touch it (it once deleted the master doc after 24h, killing /demo).
const DEMO_MASTER_EMAIL = `demo-master@${DEMO_DOMAIN}`;
const DEMO_TTL_MS = 24 * 60 * 60 * 1000;
const DEMO_MAX_ACCOUNTS = 300; // abuse brake â€” the reaper keeps it far below
const REAP_BATCH = 20;

export async function GET(request: Request) {
  const url = new URL(request.url);
  // Behind the Cloud Run proxy request.url is localhost:8080 â€” a redirect
  // built from url.origin sends the browser to a dead address. Derive the
  // real origin from the forwarded headers.
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const origin = `${proto}://${host}`;
  const masterId = process.env.DEMO_MASTER_DOC_ID;
  if (!masterId || !env.hasOpenAI) {
    return NextResponse.redirect(new URL("/login", origin));
  }

  const admin = createSupabaseAdmin();

  // Opportunistic reaping â€” fire-and-forget (CPU stays allocated on Cloud Run).
  void reapOldDemoAccounts().catch((e) => console.error("[demo] reap failed:", e));

  // Abuse brake: refuse politely when something is farming the link.
  const { data: userList } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const demoUsers = (userList?.users ?? []).filter((u) => u.email?.endsWith(`@${DEMO_DOMAIN}`));
  if (demoUsers.length >= DEMO_MAX_ACCOUNTS) {
    console.error(`[demo] account cap reached (${demoUsers.length}) â€” refusing new demo`);
    return NextResponse.redirect(new URL("/login", origin));
  }

  /* ---- 1. throwaway account ---- */
  const rand = crypto.randomUUID().replace(/-/g, "");
  const email = `demo-${rand.slice(0, 10)}@${DEMO_DOMAIN}`;
  const password = rand.slice(10);
  const { data: created, error: userErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userErr || !created?.user) {
    console.error("[demo] createUser failed:", userErr?.message);
    return NextResponse.redirect(new URL("/login", origin));
  }
  const uid = created.user.id;
  await admin.from("profiles").upsert({ user_id: uid, plan: "pro" });

  /* ---- 2. clone the master document into the new account ---- */
  const [{ data: master }, { data: pages }, { data: elements }, { data: docAi }] =
    await Promise.all([
      admin.from("documents").select("*").eq("id", masterId).maybeSingle(),
      admin.from("document_text").select("*").eq("document_id", masterId).order("page_no"),
      admin.from("document_elements").select("*").eq("document_id", masterId),
      admin.from("document_ai").select("*").eq("document_id", masterId).maybeSingle(),
    ]);
  if (!master || !pages || pages.length === 0) {
    console.error("[demo] master document missing or empty:", masterId);
    await admin.auth.admin.deleteUser(uid);
    return NextResponse.redirect(new URL("/login", origin));
  }

  const cloneId = crypto.randomUUID();
  // Own storage copies â€” the clone must be deletable without touching the master.
  let filePath: string | null = null;
  let pdfPath: string | null = null;
  if (master.file_path) {
    filePath = `${uid}/demo-${master.file_path.split("/").pop()}`;
    const { error: cpErr } = await admin.storage.from("uploads").copy(master.file_path, filePath);
    if (cpErr) {
      console.error("[demo] storage copy failed:", cpErr.message);
      await admin.auth.admin.deleteUser(uid);
      return NextResponse.redirect(new URL("/login", origin));
    }
  }
  if (master.pdf_path) {
    if (master.pdf_path === master.file_path) pdfPath = filePath;
    else {
      pdfPath = `${uid}/demo-pdf-${master.pdf_path.split("/").pop()}`;
      const { error: cp2 } = await admin.storage.from("uploads").copy(master.pdf_path, pdfPath);
      if (cp2) pdfPath = null; // reflow still works without original pages
    }
  }

  const { error: docErr } = await admin.from("documents").insert({
    id: cloneId,
    owner_id: uid,
    title: master.title,
    author: master.author,
    kind: master.kind,
    status: "ready",
    source: "upload",
    file_path: filePath,
    pdf_path: pdfPath,
  });
  if (docErr) {
    console.error("[demo] clone insert failed:", docErr.message);
    await admin.auth.admin.deleteUser(uid);
    return NextResponse.redirect(new URL("/login", origin));
  }
  await admin.from("document_text").insert(
    pages.map((p) => ({
      document_id: cloneId,
      page_no: p.page_no,
      text: p.text,
      char_start: p.char_start,
      char_end: p.char_end,
    })),
  );
  if (elements && elements.length > 0) {
    await admin.from("document_elements").insert(
      elements.map((el) => ({
        document_id: cloneId,
        kind: el.kind,
        element_no: el.element_no,
        char_start: el.char_start,
        char_end: el.char_end,
        storage_path: el.storage_path, // shared read-only; clone delete can't reach it
        content_text: el.content_text,
        caption: el.caption,
      })),
    );
  }
  if (docAi?.status === "ready") {
    await admin.from("document_ai").upsert({
      document_id: cloneId,
      status: "ready",
      markdown: docAi.markdown,
      summary_md: docAi.summary_md,
      summary_meta: docAi.summary_meta,
      error: null,
      updated_at: new Date().toISOString(),
    });
  }
  await admin
    .from("user_state")
    .upsert({ user_id: uid, last_document_id: cloneId, updated_at: new Date().toISOString() });

  /* ---- 3. sign the browser in and land in the reader ---- */
  const supabase = await createSupabaseServer();
  const { error: signErr } = await supabase.auth.signInWithPassword({ email, password });
  if (signErr) {
    console.error("[demo] sign-in failed:", signErr.message);
    return NextResponse.redirect(new URL("/login", origin));
  }
  console.log(`[demo] visitor ${email} -> doc ${cloneId}`);
  return NextResponse.redirect(new URL(`/read/${cloneId}`, origin));
}

/** Delete demo accounts older than the TTL: storage copies first, then the
 *  auth user (every DB row cascades from auth.users). Bounded per call. */
async function reapOldDemoAccounts(): Promise<void> {
  const admin = createSupabaseAdmin();
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const stale = (list?.users ?? [])
    .filter(
      (u) =>
        u.email?.endsWith(`@${DEMO_DOMAIN}`) &&
        u.email !== DEMO_MASTER_EMAIL &&
        Date.now() - new Date(u.created_at).getTime() > DEMO_TTL_MS,
    )
    .slice(0, REAP_BATCH);
  for (const u of stale) {
    try {
      // uploads/<uid>/... â€” their private copies plus anything they uploaded
      for (;;) {
        const { data: files } = await admin.storage.from("uploads").list(u.id, { limit: 100 });
        if (!files || files.length === 0) break;
        await admin.storage.from("uploads").remove(files.map((f) => `${u.id}/${f.name}`));
        if (files.length < 100) break;
      }
      await admin.auth.admin.deleteUser(u.id);
      console.log(`[demo] reaped ${u.email}`);
    } catch (e) {
      console.error(`[demo] reap of ${u.email} failed:`, e);
    }
  }
}

