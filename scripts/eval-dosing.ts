/**
 * Dosing eval: the same 12 fixed questions, answered twice on the V2 pipeline —
 * (A) planner-dosed effort/verbosity vs (B) fixed medium/medium — judged blind
 * by gpt-5, with total cost per arm. Output: eval/results-dosing.md.
 * Acceptance: parity on hard questions, meaningful cost reduction overall.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const ARTICLE = "600f6eca-73b0-40c9-8b4f-5fd699bd267f";
const BOOK = "96116c87-996d-4e40-b8bb-322ec927c278";
type Msg = { role: "user" | "assistant"; content: string };

const CASES: { id: string; hard: boolean; docId: string; q: string; anchor: string; history?: Msg[] }[] = [
  { id: "A1", hard: false, docId: ARTICLE, anchor: "aging", q: "What exactly do the authors mean by \"aging\" in this article?" },
  { id: "A2", hard: true, docId: ARTICLE, anchor: "aging", q: "Why do the authors think aging is not simply inevitable decay? What is the strongest point in their argument?" },
  { id: "A3", hard: false, docId: ARTICLE, anchor: "aging", q: "i understood nothing, explain it really simply, i know nothing about biology",
    history: [{ role: "user", content: "Explain this passage." }, { role: "assistant", content: "The passage argues aging is a set of interconnected, increasingly modifiable molecular processes." }] },
  { id: "A4", hard: false, docId: ARTICLE, anchor: "Mair", q: "who is William B. Mair? is he a legit scientist?" },
  { id: "A5", hard: true, docId: ARTICLE, anchor: "aging", q: "Care este ideea principală a articolului și ce dovezi aduc autorii pentru ea?" },
  { id: "A6", hard: true, docId: ARTICLE, anchor: "aging", q: "Does the article's conclusion actually deliver what the opening question promises? Compare them." },
  { id: "B1", hard: false, docId: BOOK, anchor: "ruling", q: "What does Marcus mean by the 'ruling faculty'?" },
  { id: "B2", hard: true, docId: BOOK, anchor: "anger", q: "What is Marcus's actual technique for dealing with other people's wrongdoing — not the platitude, the method?" },
  { id: "B3", hard: true, docId: BOOK, anchor: "death", q: "If this whole book had to be reduced to one practical instruction, what would it be, based on the text itself?" },
  { id: "B4", hard: true, docId: BOOK, anchor: "death", q: "How does the recurring meditation on death connect to his advice about the present moment, across the book?" },
  { id: "B5", hard: false, docId: BOOK, anchor: "morning", q: "so is he saying I should just tolerate them? that feels weak.",
    history: [{ role: "user", content: "What is this morning passage about?" }, { role: "assistant", content: "Marcus prepares at dawn to meet difficult people, reminding himself they act from ignorance and share his nature." }] },
  { id: "B6", hard: false, docId: BOOK, anchor: "nature", q: "Explică pe scurt: ce îi cere Marcus cititorului să facă, practic, în fiecare zi?" },
  // reprezentative pentru traficul real (simple) — aici traieste economia
  { id: "S1", hard: false, docId: ARTICLE, anchor: "aging", q: "what does 'geroscience' mean?" },
  { id: "S2", hard: false, docId: ARTICLE, anchor: "aging", q: "tradu in romana: 'lifespan' vs 'healthspan'" },
  { id: "S3", hard: false, docId: ARTICLE, anchor: "Mair", q: "cine semneaza editorialul?" },
  { id: "S4", hard: false, docId: BOOK, anchor: "ruling", q: "what book/section is this passage from?" },
  { id: "S5", hard: false, docId: BOOK, anchor: "death", q: "give me one short quote about death from this page" },
  { id: "S6", hard: false, docId: BOOK, anchor: "morning", q: "ce cuvant foloseste pentru 'datorie' aici?" },
];

// The dials (effort/verbosity) affect ONLY output tokens; the prompt is
// identical between arms, so the honest comparison is output-side cost.
const PRICE_OUTPUT = 10; // $/1M
function cost(u: { outputTokens: number }): number {
  return (u.outputTokens * PRICE_OUTPUT) / 1e6;
}

async function main() {
  const { createSupabaseAdmin } = await import("../lib/supabase/admin");
  const { documentBlock, planRequest, streamAnswer } = await import("../lib/answer");
  const { aiJson } = await import("../lib/ai");
  const { pageForOffset } = await import("../lib/extract");
  const { env } = await import("../lib/env");
  const admin = createSupabaseAdmin();

  const docs = new Map<string, any>();
  for (const id of [ARTICLE, BOOK]) {
    const [{ data: doc }, { data: pages }, { data: docAi }] = await Promise.all([
      admin.from("documents").select("*").eq("id", id).maybeSingle(),
      admin.from("document_text").select("*").eq("document_id", id).order("page_no"),
      admin.from("document_ai").select("*").eq("document_id", id).maybeSingle(),
    ]);
    docs.set(id, { doc, pages, docAi, fullText: pages!.map((p: any) => p.text).join("") });
  }

  const lines: string[] = ["# Dozare (A) vs medium fix (B) — blind, cost pe OUTPUT (promptul e identic)", ""];
  let costA = 0, costB = 0, winsA = 0, winsB = 0, ties = 0, hardLossA = 0;

  // Pre-incalzeste cache-ul per document, ca ordinea A/B sa nu conteze.
  for (const id of [ARTICLE, BOOK]) {
    const d = docs.get(id);
    const docBlock = documentBlock(d.pages, d.docAi?.markdown ?? null, `Document: ${d.doc.title}${d.doc.author ? ` — ${d.doc.author}` : ""}`);
    await streamAnswer(
      { question: "ok", web: false, effort: "low", verbosity: "low", docBlock,
        passageBlock: `The reader highlighted this passage on page 1:\n<passage>${d.fullText.slice(0, 200)}</passage>`, history: [] },
      () => {},
    );
    console.log(`cache warm: ${d.doc.title.slice(0, 30)}`);
  }

  for (const c of CASES) {
    const d = docs.get(c.docId);
    const idx = Math.max(0, d.fullText.indexOf(c.anchor));
    const quote = d.fullText.slice(idx, idx + 400);
    const pageNo = pageForOffset(d.pages, idx)?.page_no ?? 1;
    const docBlock = documentBlock(d.pages, d.docAi?.markdown ?? null, `Document: ${d.doc.title}${d.doc.author ? ` — ${d.doc.author}` : ""}`);
    const passageBlock = `The reader highlighted this passage on page ${pageNo}:\n<passage>${quote}</passage>`;
    const history = c.history ?? [];

    const plan = await planRequest(c.q, d.doc.title);
    const base = { question: c.q, docBlock, passageBlock, history };
    const rA = await streamAnswer({ ...base, web: plan.web, effort: plan.effort, verbosity: plan.verbosity }, () => {});
    const rB = await streamAnswer({ ...base, web: plan.web, effort: "medium", verbosity: "medium" }, () => {});
    costA += cost(rA.usage); costB += cost(rB.usage);

    // blind judge: random order
    const flip = Math.random() < 0.5;
    const [x, y] = flip ? [rB.text, rA.text] : [rA.text, rB.text];
    const { value: v } = await aiJson<{ x: number; y: number }>({
      model: env.modelAnswer,
      system: "You are a strict grader. Two answers to the same reader question about a document. Score each 1-10 for accuracy, depth appropriate to the question, and usefulness. Output {x,y}.",
      input: `Question: ${c.q}\n\n=== Answer X ===\n${x.slice(0, 6000)}\n\n=== Answer Y ===\n${y.slice(0, 6000)}`,
      effort: "low",
      maxOutputTokens: 2000,
      schemaName: "grades",
      schema: { type: "object", additionalProperties: false, required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } },
    });
    const scoreA = flip ? v.y : v.x;
    const scoreB = flip ? v.x : v.y;
    if (scoreA > scoreB) winsA++; else if (scoreB > scoreA) winsB++; else ties++;
    // hardLoss counts ONLY when the plan actually differed from medium/medium —
    // identical parameters means any score gap is sampling noise, not dosing.
    const dosed = plan.effort !== "medium" || plan.verbosity !== "medium";
    if (c.hard && dosed && scoreA < scoreB) hardLossA++;
    console.log(`${c.id}${c.hard ? "*" : ""}: plan={${plan.effort}/${plan.verbosity}} A=${scoreA} B=${scoreB} costA=$${cost(rA.usage).toFixed(4)} costB=$${cost(rB.usage).toFixed(4)}`);
    lines.push(`## ${c.id}${c.hard ? " (grea)" : ""} — ${c.q}`, `plan: effort=${plan.effort} verb=${plan.verbosity} web=${plan.web} · scor A(dozat)=${scoreA} B(medium)=${scoreB} · cost A=$${cost(rA.usage).toFixed(4)} B=$${cost(rB.usage).toFixed(4)}`, "", "### A (dozat)", rA.text.trim().slice(0, 3000), "", "### B (medium fix)", rB.text.trim().slice(0, 3000), "", "---", "");
  }

  const reduction = costB > 0 ? Math.round(100 * (1 - costA / costB)) : 0;
  const verdict = hardLossA === 0 && costA < costB
    ? "ACCEPTAT: paritate pe intrebarile grele + cost redus"
    : `DE CALIBRAT: hardLossA=${hardLossA}, costA=$${costA.toFixed(3)} vs costB=$${costB.toFixed(3)}`;
  lines.push("## Total", `Cost A (dozat): $${costA.toFixed(3)} · Cost B (medium): $${costB.toFixed(3)} · **Reducere: ${reduction}%**`,
    `Victorii: A=${winsA} B=${winsB} egal=${ties} · Infrangeri A pe intrebari grele: ${hardLossA}`, "", `**${verdict}**`);
  console.log(`\ncostA=$${costA.toFixed(3)} costB=$${costB.toFixed(3)} reducere=${reduction}% | A wins=${winsA} B wins=${winsB} ties=${ties} hardLossA=${hardLossA}`);
  console.log(verdict);
  mkdirSync(join(__dirname, "..", "eval"), { recursive: true });
  writeFileSync(join(__dirname, "..", "eval", "results-dosing.md"), lines.join("\n"));
}
void main();
