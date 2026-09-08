/**
 * Reproduces the reported failure: highlighting the author names and asking
 * "who are they are they legit?" — even in a thread where the reader earlier
 * asked for simple explanations. Asserts: web=true, register=standard (not
 * sticky-plain), and the REAL answer brings concrete facts about the authors
 * with no childlike analogy framing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const DOC = "600f6eca-73b0-40c9-8b4f-5fd699bd267f"; // Do you want to live forever (PLOS)
const QUOTE = "William B. Mair1*, Ines Alvarez-Garcia";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log("PASS", name, extra); }
  else { fail++; console.log("FAIL", name, extra); }
}

async function main() {
  const { dispatch } = await import("../lib/dispatcher");
  const { executeTicket } = await import("../lib/executor");
  const { createSupabaseAdmin } = await import("../lib/supabase/admin");
  const admin = createSupabaseAdmin();

  const [{ data: doc }, { data: docAi }, { data: pages }] = await Promise.all([
    admin.from("documents").select("*").eq("id", DOC).maybeSingle(),
    admin.from("document_ai").select("*").eq("document_id", DOC).maybeSingle(),
    admin.from("document_text").select("*").eq("document_id", DOC).order("page_no"),
  ]);
  if (!doc || !pages) throw new Error("doc missing");
  const fullText = pages.map((p) => p.text).join("");
  const idx = Math.max(0, fullText.indexOf("William B. Mair"));
  const before = fullText.slice(Math.max(0, idx - 600), idx);
  const after = fullText.slice(idx + QUOTE.length, idx + QUOTE.length + 600);

  const question = "who are they are they legit?";
  // thread history includes an earlier PLAIN ask — must NOT make this one plain
  const history = [
    { role: "user" as const, content: "explain in simple words what this article is about, i have no idea about this stuff" },
    { role: "assistant" as const, content: "Imagine your body is like a car..." },
  ];

  const { ticket } = await dispatch({
    question,
    quote: QUOTE,
    docTitle: doc.title,
    meta: docAi?.summary_meta ?? null,
    historyCount: history.length,
    isRegion: false,
    recentUserMessages: history.filter((m) => m.role === "user").map((m) => m.content),
  });
  console.log(`ticket: tier=${ticket.tier} register=${ticket.register} web=${ticket.web} rag=${ticket.rag_chunks}`);
  check("web enabled for author-credibility question", ticket.web === true);
  check("register is STANDARD despite earlier plain asks", ticket.register === "standard");

  const { text } = await executeTicket(
    {
      ticket, question, quote: QUOTE, before, after, pageNo: 1,
      docTitle: doc.title, docAuthor: doc.author,
      meta: docAi?.summary_meta ?? null, summaryMd: docAi?.summary_md ?? null,
      threadSummary: null, history, ragChunks: [],
    },
    () => {},
  );
  console.log("--- answer ---");
  console.log(text.trim().slice(0, 1200));
  check("answer has substance", text.trim().length > 200, `${text.trim().length} chars`);
  check("answer brings REAL outside facts (affiliation/role/field)",
    /Harvard|professor|univers|lab|aging|metabol|researcher|editor|PLOS/i.test(text));
  check("no childlike analogy framing", !/imagine (you|a |that)|party|guest list|like a car/i.test(text));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
void main();
