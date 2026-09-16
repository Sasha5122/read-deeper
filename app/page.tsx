import { redirect } from "next/navigation";
import { UploadPanel } from "@/components/upload/UploadPanel";
import { requireUser } from "@/lib/supabase/server";
import { getPlan } from "@/lib/usage";

/**
 * ChatGPT-style entry: "/" drops the user straight into the reader on their
 * last-open document (falling back to their newest one). Only a brand-new
 * account with nothing to read sees the upload-first landing below.
 */
export default async function Home() {
  const { supabase, user } = await requireUser();

  const { data: state } = await supabase
    .from("user_state")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();
  if (state?.last_document_id) {
    const { data: doc } = await supabase
      .from("documents")
      .select("id,status")
      .eq("id", state.last_document_id)
      .maybeSingle();
    if (doc?.status === "ready") redirect(`/read/${doc.id}`);
  }

  const { data: fallback } = await supabase
    .from("documents")
    .select("id")
    .eq("owner_id", user.id)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fallback) redirect(`/read/${fallback.id}`);

  const plan = await getPlan(user.id);
  return (
    <main className="grid min-h-screen place-items-center bg-neutral-100 px-4">
      <div className="w-full max-w-lg">
        <h1 className="mb-1 text-center font-[family-name:var(--font-display)] text-2xl font-semibold text-neutral-900">
          Read <span className="italic">Deeper</span>
        </h1>
        <p className="mb-6 text-center text-sm text-neutral-500">
          Upload a document to start reading — highlights, captures and AI conversations live in its margin.
        </p>
        <UploadPanel userId={user.id} plan={plan} />
      </div>
    </main>
  );
}
