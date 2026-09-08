/**
 * Blind quality eval: for each question, arm A = our dispatcher+executor
 * pipeline, arm B = the WHOLE document markdown stuffed into the heavy model.
 * A blind GPT-5 judge scores both. Ship bar: A at parity or better.
 *   npx tsx scripts/eval-quality.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

interface QCase {
  docId: string;
  question: string;
  /** Anchor phrase to simulate a highlight (passage questions); null = doc-level. */
  anchor: string | null;
}

const ARTICLE = "27f352a4-bb4c-4074-a3d7-96a72841a90f";
const ARXIV = "37930491-b4e8-4fc8-acd4-6d51a7590f5b";

const CASES: QCase[] = [
  { docId: ARTICLE, question: "De ce ar consuma conditia de control mai multe tokens?", anchor: "the control condition consumed" },
  { docId: ARTICLE, question: "Explica mai simplu ce inseamna pasajul asta.", anchor: "Readers of contracts, regulations" },
  { docId: ARTICLE, question: "Care e concluzia principala a articolului si pe ce rezultate se sprijina?", anchor: null },
  { docId: ARTICLE, question: "Ce limite metodologice are studiul?", anchor: null },
  { docId: ARXIV, question: "What is the central claim of this paper, in plain terms?", anchor: null },
  { docId: ARXIV, question: "How do the authors justify that coherence is independent of the inflationary energy scale?", anchor: null },
  { docId: ARXIV, question: "Explain this passage simply.", anchor: "phase coherence" },
  { docId: ARXIV, question: "What observations could falsify the conclusion of this paper?", anchor: null },
];

async function main() {
  const { dispatch } = await import("../lib/dispatcher");
  const { executeTicket, retrieveChunks } = await import("../lib/executor");
  const { aiText, aiJson } = await import("../lib/ai");
  const { env } = await import("../lib/env");
  const { createSupabaseAdmin } = await import("../lib/supabase/admin");
  const admin = createSupabaseAdmin();

  let aTotal = 0, bTotal = 0, aWins = 0, bWins = 0, ties = 0;

  for (const c of CASES) {
    const [{ data: doc }, { data: docAi }, { data: pages }] = await Promise.all([
      admin.from("documents").select("*").eq("id", c.docId).maybeSingle(),
      admin.from("document_ai").select("*").eq("document_id", c.docId).maybeSingle(),
      admin.from("document_text").select("*").eq("document_id", c.docId).order("page_no"),
    ]);
    if (!doc || !docAi?.markdown || !pages) {
      console.log(`SKIP ${c.question.slice(0, 40)} — AI layer missing for doc`);
      continue;
    }
    const fullText = pages.map((p) => p.text).join("");
    let quote = "the document as a whole";
    let before = "", after = "", pageNo = 1;
    if (c.anchor) {
      const idx = fullText.indexOf(c.anchor);
      if (idx >= 0) {
        const end = Math.min(idx + 260, fullText.length);
        quote = fullText.slice(idx, end);
        before = fullText.slice(Math.max(0, idx - 600), idx);
        after = fullText.slice(end, end + 600);
        pageNo = pages.find((p) => idx >= p.char_start && idx < p.char_end)?.page_no ?? 1;
      }
    }

    // ARM A — our pipeline
    const { ticket } = await dispatch({
      question: c.question,
      quote,
      docTitle: doc.title,
      meta: docAi.summary_meta,
      historyCount: 0,
      isRegion: false,
    });
    const ragChunks = await retrieveChunks(c.docId, c.question, ticket.rag_chunks);
    const armA = await executeTicket(
      {
        ticket, question: c.question, quote, before, after, pageNo,
        docTitle: doc.title, docAuthor: doc.author, meta: docAi.summary_meta,
        summaryMd: docAi.summary_md, threadSummary: null, history: [], ragChunks,
      },
      () => {},
    );

    // ARM B — whole document into the heavy model
    const armB = await aiText({
      model: env.modelDocument,
      system: `You are a careful reading companion. The user is reading this document:\n\n${docAi.markdown}\n\n${c.anchor ? `They highlighted: "${quote}"` : ""}\nAnswer in the language of the question. Cite pages like (p. 4).`,
      input: c.question,
      effort: "medium",
      maxOutputTokens: 6000,
    });

    // Blind judge (random order)
    const flip = Math.random() < 0.5;
    const first = flip ? armB.text : armA.text;
    const second = flip ? armA.text : armB.text;
    const { value: verdict } = await aiJson<{ score_1: number; score_2: number; better: string }>({
      model: env.modelDocument,
      system:
        "You judge two answers to the same reading question, blind. Score each 1-10 on: factual accuracy vs the excerpt, depth of explanation, groundedness (no invention), usefulness to a serious reader. Judge only quality, not length.",
      input: `Question: ${c.question}\n${c.anchor ? `Highlighted passage: ${quote}\n` : ""}\nAnswer 1:\n${first}\n\nAnswer 2:\n${second}`,
      effort: "medium",
      maxOutputTokens: 3000,
      schemaName: "verdict",
      schema: {
        type: "object", additionalProperties: false,
        required: ["score_1", "score_2", "better"],
        properties: {
          score_1: { type: "integer", minimum: 1, maximum: 10 },
          score_2: { type: "integer", minimum: 1, maximum: 10 },
          better: { type: "string", enum: ["1", "2", "tie"] },
        },
      },
    });
    const aScore = flip ? verdict.score_2 : verdict.score_1;
    const bScore = flip ? verdict.score_1 : verdict.score_2;
    const winner = verdict.better === "tie" ? "tie" : (verdict.better === "1") !== flip ? "A" : "B";
    aTotal += aScore; bTotal += bScore;
    if (winner === "A") aWins++; else if (winner === "B") bWins++; else ties++;
    console.log(
      `${winner === "A" ? "A✓" : winner === "B" ? "B✓" : "= "} pipeline=${aScore}/10 fulldoc=${bScore}/10 tier=${ticket.tier} rag=${ticket.rag_chunks} :: ${c.question.slice(0, 55)}`,
    );
  }

  const n = CASES.length;
  console.log(`\nPIPELINE (dispecer+context dozat): medie ${(aTotal / n).toFixed(1)}/10, ${aWins} victorii`);
  console.log(`FULL-DOC (tot documentul in GPT-5): medie ${(bTotal / n).toFixed(1)}/10, ${bWins} victorii, ${ties} egaluri`);
  console.log(aTotal >= bTotal - n * 0.3 ? "\nVERDICT: PARITATE SAU PESTE — se poate lansa" : "\nVERDICT: SUB PARITATE — mai calibram");
}
void main();
