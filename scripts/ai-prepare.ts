/**
 * Backfill / re-run the AI preparation for existing documents.
 *   npx tsx scripts/ai-prepare.ts <documentId>   one document
 *   npx tsx scripts/ai-prepare.ts --all          every ready document missing AI data
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Load .env.local before importing anything that reads env.
for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

async function main() {
  const { prepareDocumentAi } = await import("../lib/aiprep");
  const { createSupabaseAdmin } = await import("../lib/supabase/admin");
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: npx tsx scripts/ai-prepare.ts <documentId> | --all");
    process.exit(2);
  }

  const admin = createSupabaseAdmin();
  let ids: string[] = [];
  if (arg === "--all") {
    const { data: docs } = await admin.from("documents").select("id,title").eq("status", "ready");
    const { data: done } = await admin.from("document_ai").select("document_id,status");
    const ready = new Set((done ?? []).filter((d) => d.status === "ready").map((d) => d.document_id));
    ids = (docs ?? []).filter((d) => !ready.has(d.id)).map((d) => d.id);
    console.log(`${ids.length} document(e) de pregatit`);
  } else {
    ids = [arg];
  }

  for (const id of ids) {
    const t0 = Date.now();
    process.stdout.write(`prep ${id} ... `);
    await prepareDocumentAi(id);
    const { data: row } = await admin.from("document_ai").select("status,error").eq("document_id", id).maybeSingle();
    console.log(`${row?.status} (${((Date.now() - t0) / 1000).toFixed(1)}s)${row?.error ? " — " + row.error : ""}`);
  }
}
void main();
