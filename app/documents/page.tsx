import Link from "next/link";
import { Nav } from "@/components/Nav";
import { UploadPanel } from "@/components/upload/UploadPanel";
import { requireUser } from "@/lib/supabase/server";
import { getPlan } from "@/lib/usage";

export default async function DocumentsPage() {
  const { supabase, user } = await requireUser();
  const plan = await getPlan(user.id);

  const { data: documents } = await supabase
    .from("documents")
    .select("*")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: false });

  const { data: highlights } = await supabase
    .from("highlights")
    .select("id, document_id")
    .eq("user_id", user.id);
  const threadCounts = new Map<string, number>();
  for (const h of highlights ?? []) {
    threadCounts.set(h.document_id, (threadCounts.get(h.document_id) ?? 0) + 1);
  }

  return (
    <>
      <Nav active="documents" />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="mb-6 font-[family-name:var(--font-display)] text-3xl font-semibold">
          My documents
        </h1>
        <UploadPanel userId={user.id} plan={plan} />
        <ul className="mt-8 flex flex-col gap-3">
          {(documents ?? []).map((doc) => (
            <li key={doc.id}>
              <Link
                href={doc.status === "ready" ? `/read/${doc.id}` : "#"}
                className={`flex items-center gap-4 rounded-lg border border-line bg-surface p-4 ${
                  doc.status === "ready" ? "hover:border-accent" : "cursor-default opacity-70"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{doc.title}</p>
                  <p className="text-xs text-ink-faint">
                    {doc.kind.toUpperCase()} ·{" "}
                    {new Date(doc.created_at).toLocaleDateString()}
                  </p>
                </div>
                <span className="text-xs text-ink-soft">
                  {threadCounts.get(doc.id) ?? 0} threads
                </span>
                <StatusPill status={doc.status} />
              </Link>
            </li>
          ))}
          {(documents ?? []).length === 0 && (
            <li className="py-6 text-center text-sm text-ink-faint">No uploads yet.</li>
          )}
        </ul>
      </main>
    </>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    ready: "bg-accent-wash text-accent-deep",
    processing: "bg-amber-100 text-amber-800",
    failed: "bg-red-100 text-red-700",
  };
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${styles[status] ?? ""}`}>
      {status}
    </span>
  );
}
