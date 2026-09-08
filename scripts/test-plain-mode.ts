/**
 * Reproduces the exact failed-understanding session from live use, on the
 * same paper: three increasingly desperate "explain simply" asks. Asserts the
 * dissatisfaction cascade (tier escalation + plain register) and that the
 * final answer contains NO echoed jargon.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const DOC = "1f992f49-2945-46b8-943b-8f0a9ebd25ea"; // From Question to Evidence
const ANCHOR = "A factual analyzer should not invent a new measuring method";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log("PASS", name, extra); }
  else { fail++; console.log("FAIL", name, extra); }
}

const JARGON = /deterministic policy|governed meaning|scoped completeness|relational operations|first-order|typed operations/i;

async function main() {
  const { dispatch } = await import("../lib/dispatcher");
  const { executeTicket, retrieveChunks } = await import("../lib/executor");
  const { createSupabaseAdmin } = await import("../lib/supabase/admin");
  const admin = createSupabaseAdmin();

  const [{ data: doc }, { data: docAi }, { data: pages }] = await Promise.all([
    admin.from("documents").select("*").eq("id", DOC).maybeSingle(),
    admin.from("document_ai").select("*").eq("document_id", DOC).maybeSingle(),
    admin.from("document_text").select("*").eq("document_id", DOC).order("page_no"),
  ]);
  if (!doc || !pages) throw new Error("doc missing");
  const fullText = pages.map((p) => p.text).join("");
  const idx = fullText.indexOf(ANCHOR);
  const quote = fullText.slice(idx, idx + 900);
  const before = fullText.slice(Math.max(0, idx - 600), idx);
  const after = fullText.slice(idx + 900, idx + 1500);

  const asks = [
    "explain in simply words that i can understand with no idea about this staff what is it about",
    "more simply in one phrase what exactly problem they looking for and what they want to do for someone who has no idea about this staff",
    "i have understand nothing explain like in real life for a simple person with no high scholl",
  ];

  const history: { role: "user" | "assistant"; content: string }[] = [];
  const userMsgs: string[] = [];

  for (let i = 0; i < asks.length; i++) {
    const q = asks[i];
    const { ticket } = await dispatch({
      question: q,
      quote,
      docTitle: doc.title,
      meta: docAi?.summary_meta ?? null,
      historyCount: history.length,
      isRegion: false,
      recentUserMessages: userMsgs.slice(-3),
    });
    console.log(`\n[ask ${i + 1}] tier=${ticket.tier} register=${ticket.register} len=${ticket.answer_length}`);

    if (i === 0) check("ask1: plain register detected", ticket.register === "plain");
    if (i === 2) {
      check("ask3: escalated above passage tier", ticket.tier === "document" || ticket.tier === "research", ticket.tier);
      check("ask3: plain register", ticket.register === "plain");
    }

    const ragChunks = await retrieveChunks(DOC, q, ticket.rag_chunks);
    const { text } = await executeTicket(
      {
        ticket, question: q, quote, before, after, pageNo: 1,
        docTitle: doc.title, docAuthor: doc.author,
        meta: docAi?.summary_meta ?? null, summaryMd: docAi?.summary_md ?? null,
        threadSummary: null, history: [...history], ragChunks,
      },
      () => {},
    );
    console.log("--- answer ---");
    console.log(text.trim().slice(0, 900));
    if (i === 2) {
      check("ask3: no echoed jargon", !JARGON.test(text), (JARGON.exec(text)?.[0] ?? ""));
      check("ask3: no page-citation spam", (text.match(/\(p\.\s*\d+\)/g) ?? []).length <= 1,
        `${(text.match(/\(p\.\s*\d+\)/g) ?? []).length} citations`);
      check("ask3: has substance", text.trim().length > 150, `${text.trim().length} chars`);
    }
    history.push({ role: "user", content: q }, { role: "assistant", content: text });
    userMsgs.push(q);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
void main();
