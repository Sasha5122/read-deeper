/**
 * V2 verification (§10 of the refactor spec): 12 fixed questions on 2 documents
 * (short article + a book), OLD pipeline (dispatcher+tiers) vs NEW (full doc +
 * strong model), side by side in eval/results.md, with cache-hit and TTFT data.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const ARTICLE = "600f6eca-73b0-40c9-8b4f-5fd699bd267f"; // PLOS aging essay (short)
const BOOK = "96116c87-996d-4e40-b8bb-322ec927c278"; // Meditations (~100k tokens)

type Msg = { role: "user" | "assistant"; content: string };

interface Case {
  id: string;
  kind: string;
  docId: string;
  question: string;
  anchor: string; // snippet to locate the highlighted passage
  history?: Msg[];
  expectWeb?: boolean;
}

const CASES: Case[] = [
  { id: "A1", kind: "definition", docId: ARTICLE, anchor: "aging", question: "What exactly do the authors mean by \"aging\" in this article?" },
  { id: "A2", kind: "interpretive", docId: ARTICLE, anchor: "aging", question: "Why do the authors think aging is not simply inevitable decay? What is the strongest point in their argument?" },
  {
    id: "A3", kind: "explain-simpler follow-up", docId: ARTICLE, anchor: "aging",
    question: "i understood nothing, explain it really simply, i know nothing about biology",
    history: [
      { role: "user", content: "Explain this passage." },
      { role: "assistant", content: "The passage argues that aging is a set of interconnected molecular processes — genomic instability, epigenetic drift, mitochondrial decline — that are increasingly seen as modifiable rather than fixed." },
    ],
  },
  { id: "A4", kind: "external-fact (must trigger web)", docId: ARTICLE, anchor: "Mair", question: "who is William B. Mair? is he a legit scientist?", expectWeb: true },
  { id: "A5", kind: "non-English", docId: ARTICLE, anchor: "aging", question: "Care este ideea principală a articolului și ce dovezi aduc autorii pentru ea?" },
  { id: "A6", kind: "cross-section", docId: ARTICLE, anchor: "aging", question: "Does the article's conclusion actually deliver what the opening question promises? Compare them." },
  { id: "B1", kind: "definition", docId: BOOK, anchor: "ruling", question: "What does Marcus mean by the 'ruling faculty'?" },
  { id: "B2", kind: "interpretive", docId: BOOK, anchor: "anger", question: "What is Marcus's actual technique for dealing with other people's wrongdoing — not the platitude, the method?" },
  { id: "B3", kind: "main conclusion", docId: BOOK, anchor: "death", question: "If this whole book had to be reduced to one practical instruction, what would it be, based on the text itself?" },
  { id: "B4", kind: "cross-section", docId: BOOK, anchor: "death", question: "How does the recurring meditation on death connect to his advice about the present moment, across the book?" },
  {
    id: "B5", kind: "continued thread (5 msgs)", docId: BOOK, anchor: "morning",
    question: "so is he saying I should just tolerate them? that feels weak.",
    history: [
      { role: "user", content: "What is this morning passage about?" },
      { role: "assistant", content: "Marcus prepares himself at dawn: he will meet meddling, ungrateful, arrogant people — and he reminds himself they act from ignorance of good and evil, and that he shares their nature." },
      { role: "user", content: "Why does he expect the worst of people?" },
      { role: "assistant", content: "It is a premeditation exercise: by expecting difficult people, he removes surprise and resentment, and re-frames them as kin rather than enemies." },
    ],
  },
  { id: "B6", kind: "non-English", docId: BOOK, anchor: "nature", question: "Explică pe scurt: ce îi cere Marcus cititorului să facă, practic, în fiecare zi?" },
];

async function main() {
  const { createSupabaseAdmin } = await import("../lib/supabase/admin");
  const { dispatch } = await import("../lib/dispatcher");
  const { executeTicket } = await import("../lib/executor");
  const { retrieveChunks } = await import("../lib/rag");
  const { classifyWeb, documentBlock, docTokenCount, streamAnswer } = await import("../lib/answer");
  const { SURROUNDING_CHARS } = await import("../lib/context");
  const { pageForOffset } = await import("../lib/extract");
  const { env } = await import("../lib/env");
  const admin = createSupabaseAdmin();

  const docs = new Map<string, { doc: any; pages: any[]; fullText: string; docAi: any }>();
  for (const id of [ARTICLE, BOOK]) {
    const [{ data: doc }, { data: pages }, { data: docAi }] = await Promise.all([
      admin.from("documents").select("*").eq("id", id).maybeSingle(),
      admin.from("document_text").select("*").eq("document_id", id).order("page_no"),
      admin.from("document_ai").select("*").eq("document_id", id).maybeSingle(),
    ]);
    docs.set(id, { doc, pages: pages ?? [], fullText: (pages ?? []).map((p) => p.text).join(""), docAi });
  }

  const lines: string[] = [
    "# V1 vs V2 — 12 întrebări fixe, răspunsuri una lângă alta",
    "",
    `Rulat: ${new Date().toISOString()} · V2 model: ${env.modelAnswer}, effort=${env.reasoningEffortAnswer}, full-context limit=${env.docFullContextMaxTokens} tokens`,
    "",
  ];
  const cacheStats: { docId: string; req: number; input: number; cached: number }[] = [];
  const ttfts: { id: string; docId: string; ttft: number }[] = [];
  const reqCount = new Map<string, number>();

  for (const c of CASES) {
    const d = docs.get(c.docId)!;
    const idx = Math.max(0, d.fullText.indexOf(c.anchor));
    const quote = d.fullText.slice(idx, idx + 400);
    const pageNo = pageForOffset(d.pages, idx)?.page_no ?? 1;
    const history: Msg[] = c.history ?? [];
    console.log(`\n=== ${c.id} (${c.kind}) ===`);

    /* ---------- OLD (V1) ---------- */
    const meta = d.docAi?.status === "ready" ? d.docAi.summary_meta : null;
    const { ticket } = await dispatch({
      question: c.question, quote, docTitle: d.doc.title, meta,
      historyCount: history.length, isRegion: false,
      recentUserMessages: history.filter((m) => m.role === "user").map((m) => m.content),
    });
    const surround = ticket.surrounding;
    const oldRag = await retrieveChunks(c.docId, c.question, ticket.rag_chunks);
    const oldRes = await executeTicket(
      {
        ticket, question: c.question, quote,
        before: surround > 0 ? d.fullText.slice(Math.max(0, idx - surround), idx) : "",
        after: surround > 0 ? d.fullText.slice(idx + 400, idx + 400 + surround) : "",
        pageNo, docTitle: d.doc.title, docAuthor: d.doc.author, meta,
        summaryMd: d.docAi?.summary_md ?? null, threadSummary: null, history, ragChunks: oldRag,
      },
      () => {},
    );
    console.log(`  V1: tier=${ticket.tier} web=${ticket.web} -> ${oldRes.text.length} chars`);

    /* ---------- NEW (V2) ---------- */
    const docTokens = docTokenCount(d.pages);
    const web = await classifyWeb(c.question, d.doc.title);
    const header = `Document: ${d.doc.title}${d.doc.author ? ` — ${d.doc.author}` : ""}`;
    const newRes = await streamAnswer(
      {
        question: c.question, web,
        docBlock: documentBlock(d.pages, d.docAi?.status === "ready" ? d.docAi.markdown : null, header),
        passageBlock: `The reader highlighted this passage on page ${pageNo}:\n<passage>${quote}</passage>`,
        history,
      },
      () => {},
    );
    const n = (reqCount.get(c.docId) ?? 0) + 1;
    reqCount.set(c.docId, n);
    cacheStats.push({ docId: c.docId, req: n, input: newRes.usage.inputTokens, cached: newRes.usage.cachedInputTokens });
    ttfts.push({ id: c.id, docId: c.docId, ttft: newRes.ttftMs });
    console.log(`  V2: web=${web} in=${newRes.usage.inputTokens} cached=${newRes.usage.cachedInputTokens} ttft=${newRes.ttftMs}ms -> ${newRes.text.length} chars`);
    if (c.expectWeb) console.log(`  expectWeb=${c.expectWeb} got=${web} ${web === c.expectWeb ? "OK" : "MISS"}`);

    lines.push(
      `## ${c.id} — ${c.kind}`,
      `**Doc:** ${d.doc.title} · **Întrebare:** ${c.question}`,
      c.expectWeb ? `**Web asteptat:** da · **V2 web:** ${web}` : "",
      "",
      "### V1 (dispecer + niveluri)",
      `*tier=${ticket.tier}, web=${ticket.web}, register=${ticket.register}*`,
      "", oldRes.text.trim(), "",
      "### V2 (document intreg + model puternic)",
      `*web=${web}, input=${newRes.usage.inputTokens} (cached=${newRes.usage.cachedInputTokens}), output=${newRes.usage.outputTokens}, reasoning=${newRes.usage.reasoningTokens}, TTFT=${newRes.ttftMs}ms, total=${newRes.totalMs}ms*`,
      "", newRes.text.trim(), "", "---", "",
    );
  }

  lines.push("## Cache & TTFT", "", "| doc | request # | input | cached | cache % |", "|---|---|---|---|---|");
  for (const s of cacheStats) {
    const title = docs.get(s.docId)!.doc.title.slice(0, 24);
    lines.push(`| ${title} | ${s.req} | ${s.input} | ${s.cached} | ${s.input ? Math.round((100 * s.cached) / s.input) : 0}% |`);
  }
  lines.push("", "| caz | doc | TTFT ms |", "|---|---|---|");
  for (const t of ttfts) lines.push(`| ${t.id} | ${docs.get(t.docId)!.doc.title.slice(0, 24)} | ${t.ttft} |`);

  mkdirSync(join(__dirname, "..", "eval"), { recursive: true });
  writeFileSync(join(__dirname, "..", "eval", "results.md"), lines.filter((l) => l !== undefined).join("\n"));
  console.log("\nscris: eval/results.md");
}
void main();
