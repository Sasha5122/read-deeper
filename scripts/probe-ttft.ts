/** Dev probe: TTFT vs reasoning effort on the V2 pipeline (article + book, cached prefix). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const ARTICLE = "600f6eca-73b0-40c9-8b4f-5fd699bd267f";
const BOOK = "96116c87-996d-4e40-b8bb-322ec927c278";

async function main() {
  const { createSupabaseAdmin } = await import("../lib/supabase/admin");
  const { documentBlock, streamAnswer } = await import("../lib/answer");
  const admin = createSupabaseAdmin();

  for (const [label, id, q] of [
    ["articol", ARTICLE, "What is the key claim here?"],
    ["carte", BOOK, "What is Marcus's view of fame?"],
  ] as const) {
    const [{ data: doc }, { data: pages }, { data: docAi }] = await Promise.all([
      admin.from("documents").select("*").eq("id", id).maybeSingle(),
      admin.from("document_text").select("*").eq("document_id", id).order("page_no"),
      admin.from("document_ai").select("*").eq("document_id", id).maybeSingle(),
    ]);
    const docBlock = documentBlock(pages!, docAi?.markdown ?? null, `Document: ${doc!.title}`);
    const passage = `The reader highlighted this passage on page 1:\n<passage>${pages![0].text.slice(0, 300)}</passage>`;
    for (const effort of ["minimal", "low", "medium"] as const) {
      process.env.REASONING_EFFORT_ANSWER = effort;
      const r = await streamAnswer(
        { question: q, web: false, docBlock, passageBlock: passage, history: [] },
        () => {},
      );
      console.log(
        `${label} effort=${effort}: ttft=${r.ttftMs}ms total=${r.totalMs}ms cached=${r.usage.cachedInputTokens}/${r.usage.inputTokens} reason=${r.usage.reasoningTokens} out=${r.usage.outputTokens}`,
      );
    }
  }
}
void main();
