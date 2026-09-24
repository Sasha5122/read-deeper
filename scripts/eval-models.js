/**
 * Model-upgrade eval (2026-09-24): can we (a) move the answer model
 * gpt-5 -> gpt-6-sol and (b) route EASY questions to gpt-6-luna, without
 * quality loss users would notice?
 *
 * Method (pattern from scripts/eval-dosing.ts / eval/results.md):
 *   3 models x 12 fixed questions (6 EASY effort=low/verb=low,
 *   6 HARD effort=medium/verb=medium) on the zebra doc, EXACT production
 *   prompt shape (strings copied from lib/answer.ts), streaming Responses
 *   API for TTFT, then a blind gpt-5 judge ranks the 3 answers per question
 *   in randomized order. Output: eval/results-models.md.
 *
 * Plain JS on purpose — imports nothing from lib/, talks to OpenAI + local
 * Supabase REST directly (no dev server). Run: node scripts/eval-models.js
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/* ---------------------------------------------------------------- env */
for (const line of fs
  .readFileSync(path.join(__dirname, "..", ".env.local"), "utf-8")
  .split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY missing (.env.local)");
  process.exit(1);
}

// Local Supabase (demo service key — public demo value, local stack only,
// same as scripts/test-ux-suite.js).
const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const ZEBRA = "8d030271-2e23-4a9b-bfb1-5e8802b70839";

const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ------------------------------------------------- production prompt
 * The strings below are VERBATIM COPIES from lib/answer.ts (ANSWER_SYSTEM,
 * documentBlock, answerHeader, the assistant ack in buildAnswerRequest) and
 * the passageBlock template from app/api/threads/[threadId]/messages/route.ts
 * — copies for eval only, so this script needs no TS/lib imports. If
 * lib/answer.ts changes, re-copy. */
const ANSWER_SYSTEM = `You are an expert reading alongside the reader, answering about the passage they highlighted in the document below.
You have the full document; use it freely and cite pages like (p. 4). Quote the text briefly when it helps.
Stay faithful to the document. If something is not in it, say so, then answer from general knowledge if you can, clearly marked as such.
Match the reader's level and the language of their question. If they ask for a simpler explanation, explain simply without talking down to them.
Be as thorough as the question deserves: give the reasoning, an example or consequence where useful, and note important nuances. Do not pad, do not restate the question.
Use light Markdown (bold for key terms, short lists only when they genuinely help).`;

const ASSISTANT_ACK =
  "Understood — I have the document and the highlighted passage. What would you like to know?";

function answerHeader(document, meta) {
  return `Document: ${document.title}${document.author ? ` — ${document.author}` : ""}${meta ? ` (${meta.doc_type}, ${meta.language})` : ""}`;
}

function documentBlock(pages, markdown, header) {
  const body =
    markdown ?? pages.map((p) => `<!-- page ${p.page_no} -->\n\n${p.text}`).join("\n\n");
  return `${header}\n\n<document>\n${body}\n</document>`;
}

/* ------------------------------------------------------- question set */
// EASY = the "effort low" class (Luna candidates); HARD = the Sol class.
const QUESTIONS = [
  { id: "E1", cls: "easy", q: "Ce înseamnă «aposematism»? Pe scurt." },
  { id: "E2", cls: "easy", q: "Tradu în română propoziția despre orizontul de detecție al muștelor." },
  { id: "E3", cls: "easy", q: "Câte muște au fost folosite în experiment?" },
  { id: "E4", cls: "easy", q: "Ce specie de cal apare în studiu?" },
  { id: "E5", cls: "easy", q: "Pe ce pagină se descriu metodele video? Pe scurt." },
  { id: "E6", cls: "easy", q: "Ce înseamnă «ecvidee»?" },
  { id: "H1", cls: "hard", q: "De ce funcționează dungile împotriva muștelor conform datelor, și ce ipoteze resping autorii?" },
  { id: "H2", cls: "hard", q: "Verifică dacă concluzia principală e susținută de rezultatele din tabele — argumentează." },
  { id: "H3", cls: "hard", q: "Compară comportamentul muștelor la apropiere vs aterizare și explică mecanismul propus." },
  { id: "H4", cls: "hard", q: "Ce limitări metodologice are studiul și cât de mult subminează concluziile?" },
  { id: "H5", cls: "hard", q: "Sintetizează tot studiul în 5 idei esențiale cu paginile lor." },
  { id: "H6", cls: "hard", q: "Ce experimente de continuare ar fi cele mai informative și de ce?" },
];

/* --------------------------------------------------------- run matrix */
const MODELS = ["gpt-5", "gpt-6-sol", "gpt-6-luna"];

// $ per 1M tokens. gpt-6-* cached prices are ASSUMPTIONS (10% of input,
// mirroring gpt-5's published ratio) — flagged in the report.
const PRICES = {
  "gpt-5": { input: 1.25, cached: 0.125, output: 10, cachedAssumed: false },
  "gpt-6-sol": { input: 2, cached: 0.2, output: 10, cachedAssumed: true },
  "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5, cachedAssumed: true },
};
function costOf(model, u) {
  const p = PRICES[model];
  return (
    ((u.inputTokens - u.cachedInputTokens) * p.input +
      u.cachedInputTokens * p.cached +
      u.outputTokens * p.output) /
    1e6
  );
}

/* Per-model param compatibility, learned at runtime: if a model rejects
 * reasoning.effort or text.verbosity we retry without it and record the fact
 * (it matters for integration — the app passes both on every call). */
const compat = Object.fromEntries(
  MODELS.map((m) => [m, { reasoning: true, verbosity: true, available: true, notes: [] }]),
);

function classifyParamError(msg) {
  const s = String(msg ?? "").toLowerCase();
  if (/model|not found|does not exist|deprecated|unavailable|access/.test(s) && /model/.test(s))
    return "model";
  if (/reasoning/.test(s)) return "reasoning";
  if (/verbosity|text\.verbosity|'text'/.test(s)) return "verbosity";
  return null;
}

async function streamOnce(model, params) {
  const t0 = Date.now();
  let ttft = 0;
  const stream = client.responses.stream(params);
  stream.on("response.output_text.delta", () => {
    if (!ttft) ttft = Date.now() - t0;
  });
  const final = await stream.finalResponse();
  const u = final.usage;
  return {
    text: final.output_text ?? "",
    ttftMs: ttft,
    totalMs: Date.now() - t0,
    usage: {
      inputTokens: u?.input_tokens ?? 0,
      cachedInputTokens: u?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      reasoningTokens: u?.output_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

async function askModel(model, question, effort, verbosity, promptParts) {
  const c = compat[model];
  // up to 3 attempts: full params -> drop rejected param(s) -> bare
  for (let attempt = 0; attempt < 3; attempt++) {
    const params = {
      model,
      instructions: ANSWER_SYSTEM,
      input: [
        { role: "user", content: promptParts.docBlock + "\n\n" + promptParts.passageBlock },
        { role: "assistant", content: ASSISTANT_ACK },
        { role: "user", content: question },
      ],
      max_output_tokens: 8000,
      prompt_cache_key: "eval-" + model,
      ...(c.reasoning ? { reasoning: { effort } } : {}),
      ...(c.verbosity ? { text: { verbosity } } : {}),
    };
    try {
      return await streamOnce(model, params);
    } catch (err) {
      const kind = classifyParamError(err?.message ?? err);
      if (kind === "model") {
        c.available = false;
        c.notes.push(`model unavailable: ${String(err?.message).slice(0, 200)}`);
        throw Object.assign(new Error("MODEL_UNAVAILABLE"), { cause: err });
      }
      if (kind === "reasoning" && c.reasoning) {
        c.reasoning = false;
        c.notes.push(`rejects reasoning.effort — retried without it (${String(err?.message).slice(0, 160)})`);
        continue;
      }
      if (kind === "verbosity" && c.verbosity) {
        c.verbosity = false;
        c.notes.push(`rejects text.verbosity — retried without it (${String(err?.message).slice(0, 160)})`);
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable: 3 attempts exhausted for " + model);
}

/* --------------------------------------------------------- blind judge */
const JUDGE_SYSTEM = `You are a strict blind judge. You get one reader question about a document passage and up to three candidate answers labeled A, B, C. Rank them best-to-worst on:
1. factual grounding in the document (no invented facts, correct page citations),
2. completeness for the question asked,
3. appropriate depth (an easy question wants a crisp answer, a hard one wants real analysis).
A shorter answer that is correct and complete beats a longer one with fluff or errors. Output JSON {ranking, notes, any_wrong_or_shallow}: ranking = labels best first; any_wrong_or_shallow = labels whose answer contains a factual error or is too shallow for the question (empty if none).`;

async function judgeOne(question, labeled) {
  const labels = labeled.map((l) => l.label);
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["ranking", "notes", "any_wrong_or_shallow"],
    properties: {
      ranking: { type: "array", items: { type: "string", enum: labels } },
      notes: { type: "string" },
      any_wrong_or_shallow: { type: "array", items: { type: "string", enum: labels } },
    },
  };
  const input =
    `Question: ${question}\n\n` +
    labeled
      .map((l) => `=== Answer ${l.label} ===\n${(l.text || "(empty answer)").slice(0, 6000)}`)
      .join("\n\n");
  const res = await client.responses.create({
    model: "gpt-5",
    instructions: JUDGE_SYSTEM,
    input,
    reasoning: { effort: "medium" },
    max_output_tokens: 6000,
    text: {
      format: { type: "json_schema", name: "verdict", strict: true, schema },
    },
  });
  return JSON.parse(res.output_text ?? "{}");
}

/* -------------------------------------------------------------- main */
const CACHE_FILE = path.join(os.tmpdir(), "rd-eval-models-cache.json");
const runCache = fs.existsSync(CACHE_FILE)
  ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"))
  : {};
function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(runCache));
}

async function sb(pathQ) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathQ}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`supabase ${pathQ}: ${res.status} ${await res.text()}`);
  return res.json();
}

const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms");

async function main() {
  /* ---- load the zebra doc exactly as the messages route does ---- */
  const [docs, pages, ais] = await Promise.all([
    sb(`documents?id=eq.${ZEBRA}&select=*`),
    sb(`document_text?document_id=eq.${ZEBRA}&select=*&order=page_no`),
    sb(`document_ai?document_id=eq.${ZEBRA}&select=*`),
  ]);
  const doc = docs[0];
  const docAi = ais[0] ?? null;
  if (!doc || pages.length === 0) throw new Error("zebra doc not found in local DB");
  const ready = docAi?.status === "ready";
  const meta = ready ? docAi.summary_meta : null;
  const header = answerHeader(doc, meta);
  const docBlock = documentBlock(pages, ready ? docAi.markdown : null, header);
  // Fixed highlight: first ~200 chars of page 1 (same for every run).
  const quote = pages[0].text.slice(0, 200);
  const passageBlock = `The reader highlighted this passage on page 1:\n<passage>${quote}</passage>`;
  console.log(
    `doc "${doc.title}" pages=${pages.length} markdown=${ready ? "ready" : "MISSING"} docBlock=${docBlock.length} chars`,
  );

  /* ---- run matrix: model x question (EASY first so each model's cache
   * lanes warm within their own effort lane; first call per lane is cold) */
  const runs = []; // {model, qid, cls, ttftMs, totalMs, usage, cost, text, error}
  for (const model of MODELS) {
    for (const c of QUESTIONS) {
      if (!compat[model].available) {
        runs.push({ model, qid: c.id, cls: c.cls, error: "model unavailable" });
        continue;
      }
      const key = `${model}::${c.id}`;
      if (runCache[key]) {
        runs.push(runCache[key]);
        console.log(`${model} ${c.id}: cached run reused`);
        continue;
      }
      const effort = c.cls === "easy" ? "low" : "medium";
      const verbosity = c.cls === "easy" ? "low" : "medium";
      try {
        const r = await askModel(model, c.q, effort, verbosity, { docBlock, passageBlock });
        const run = {
          model,
          qid: c.id,
          cls: c.cls,
          effort,
          verbosity,
          ttftMs: r.ttftMs,
          totalMs: r.totalMs,
          usage: r.usage,
          cost: costOf(model, r.usage),
          text: r.text,
        };
        runs.push(run);
        runCache[key] = run;
        saveCache();
        const u = r.usage;
        const cachePct = u.inputTokens ? Math.round((100 * u.cachedInputTokens) / u.inputTokens) : 0;
        console.log(
          `${model} ${c.id} (${effort}/${verbosity}): ttft=${fmtMs(r.ttftMs)} total=${fmtMs(r.totalMs)} ` +
            `in=${u.inputTokens} cached=${u.cachedInputTokens} (${cachePct}%) out=${u.outputTokens} ` +
            `reason=${u.reasoningTokens} cost=$${costOf(model, u).toFixed(4)} len=${r.text.length}`,
        );
      } catch (err) {
        if (err.message === "MODEL_UNAVAILABLE") {
          runs.push({ model, qid: c.id, cls: c.cls, error: "model unavailable" });
          console.log(`${model} ${c.id}: MODEL UNAVAILABLE — skipping the rest of this model`);
        } else {
          runs.push({ model, qid: c.id, cls: c.cls, error: String(err?.message).slice(0, 300) });
          console.log(`${model} ${c.id}: ERROR ${String(err?.message).slice(0, 200)}`);
        }
      }
    }
  }

  /* ---- blind judge: randomized labels per question ---- */
  const judgments = {}; // qid -> {mapping: {label: model}, ranking, notes, any_wrong_or_shallow}
  for (const c of QUESTIONS) {
    const candidates = runs.filter((r) => r.qid === c.id && !r.error && r.text);
    if (candidates.length < 2) {
      console.log(`judge ${c.id}: skipped (${candidates.length} answers)`);
      continue;
    }
    const jkey = `judge::${c.id}::${candidates.map((r) => r.model).join(",")}`;
    if (runCache[jkey]) {
      judgments[c.id] = runCache[jkey];
      console.log(`judge ${c.id}: cached verdict reused`);
      continue;
    }
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    const labeled = shuffled.map((r, i) => ({ label: "ABC"[i], model: r.model, text: r.text }));
    const mapping = Object.fromEntries(labeled.map((l) => [l.label, l.model]));
    try {
      const v = await judgeOne(c.q, labeled);
      judgments[c.id] = { mapping, ...v };
      runCache[jkey] = judgments[c.id];
      saveCache();
      console.log(
        `judge ${c.id}: ${v.ranking.map((l) => mapping[l]).join(" > ")}` +
          (v.any_wrong_or_shallow?.length
            ? ` | flagged: ${v.any_wrong_or_shallow.map((l) => mapping[l]).join(", ")}`
            : ""),
      );
    } catch (err) {
      console.log(`judge ${c.id}: ERROR ${String(err?.message).slice(0, 200)}`);
    }
  }

  /* ------------------------------------------------------ aggregate */
  const agg = {}; // model -> cls -> {n, ttft, total, cost, ranks[], wins, losses, flagged}
  for (const model of MODELS)
    agg[model] = {
      easy: { n: 0, ttft: 0, total: 0, cost: 0, ranks: [], wins: 0, losses: 0, flagged: 0 },
      hard: { n: 0, ttft: 0, total: 0, cost: 0, ranks: [], wins: 0, losses: 0, flagged: 0 },
    };
  for (const r of runs) {
    if (r.error) continue;
    const a = agg[r.model][r.cls];
    a.n++;
    a.ttft += r.ttftMs;
    a.total += r.totalMs;
    a.cost += r.cost;
  }
  for (const c of QUESTIONS) {
    const j = judgments[c.id];
    if (!j) continue;
    const order = j.ranking.map((l) => j.mapping[l]);
    order.forEach((model, i) => {
      const a = agg[model]?.[c.cls];
      if (!a) return;
      a.ranks.push(i + 1);
      if (i === 0) a.wins++;
      if (i === order.length - 1 && order.length > 1) a.losses++;
    });
    for (const l of j.any_wrong_or_shallow ?? []) {
      const a = agg[j.mapping[l]]?.[c.cls];
      if (a) a.flagged++;
    }
  }
  const avg = (a, k) => (a.n ? a[k] / a.n : 0);
  const avgRank = (a) =>
    a.ranks.length ? (a.ranks.reduce((s, x) => s + x, 0) / a.ranks.length).toFixed(2) : "—";

  /* ------------------------------------------------------ report */
  const L = [];
  L.push("# Model eval — gpt-5 vs gpt-6-sol vs gpt-6-luna (zebra doc)");
  L.push("");
  L.push(
    `Rulat: ${new Date().toISOString()} · doc: "${doc.title}" (${pages.length} pag, docBlock ${docBlock.length} chars, markdown ${ready ? "ready" : "absent"}) · prompt = forma EXACTA de productie (copii verbatim din lib/answer.ts) · EASY: effort=low/verb=low · HARD: effort=medium/verb=medium · max_output_tokens=8000 · prompt_cache_key="eval-<model>" · judecator: gpt-5 effort=medium, ordine A/B/C randomizata.`,
  );
  L.push("");
  L.push("## Compatibilitate parametri (conteaza pentru integrare)");
  for (const m of MODELS) {
    const c = compat[m];
    if (!c.available) {
      L.push(`- **${m}**: INDISPONIBIL — ${c.notes.join("; ") || "model error"}`);
    } else {
      L.push(
        `- **${m}**: reasoning.effort ${c.reasoning ? "ACCEPTAT" : "RESPINS"} · text.verbosity ${c.verbosity ? "ACCEPTAT" : "RESPINS"}${c.notes.length ? " — " + c.notes.join("; ") : ""}`,
      );
    }
  }
  const assumed = MODELS.filter((m) => PRICES[m].cachedAssumed);
  if (assumed.length)
    L.push(
      `- Preturi cached-input pentru ${assumed.join(", ")}: PRESUPUSE la 10% din input (raportul gpt-5) — de verificat la integrare.`,
    );
  // Cache behaviour, measured: with a byte-identical ~12k prefix and the same
  // prompt_cache_key, every call after the first SHOULD report cached tokens.
  for (const m of MODELS) {
    const ok = runs.filter((r) => r.model === m && !r.error);
    if (ok.length < 2) continue;
    const hits = ok.filter((r) => r.usage.cachedInputTokens > 0).length;
    L.push(
      `- **${m} prompt cache**: ${hits}/${ok.length} apeluri cu cached>0` +
        (hits === 0
          ? " — CACHE INEXISTENT/NERAPORTAT pe acest model desi prefixul e byte-identic; warm-cache-ul de productie nu ar reduce costul aici. De reprobat la integrare."
          : ""),
    );
  }
  L.push("");
  L.push("## Per intrebare");
  L.push("");
  L.push("| Q | clasa | model | TTFT | total | in (cached) | out (reason) | cost | rank | flag |");
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const c of QUESTIONS) {
    const j = judgments[c.id];
    for (const model of MODELS) {
      const r = runs.find((x) => x.qid === c.id && x.model === model);
      if (!r) continue;
      if (r.error) {
        L.push(`| ${c.id} | ${c.cls} | ${model} | — | — | — | — | — | — | ERROR: ${r.error} |`);
        continue;
      }
      let rank = "—",
        flag = "";
      if (j) {
        const order = j.ranking.map((l) => j.mapping[l]);
        const i = order.indexOf(model);
        if (i >= 0) rank = String(i + 1);
        if ((j.any_wrong_or_shallow ?? []).some((l) => j.mapping[l] === model)) flag = "WRONG/SHALLOW";
      }
      const u = r.usage;
      L.push(
        `| ${c.id} | ${c.cls} | ${model} | ${fmtMs(r.ttftMs)} | ${fmtMs(r.totalMs)} | ${u.inputTokens} (${u.cachedInputTokens}) | ${u.outputTokens} (${u.reasoningTokens}) | $${r.cost.toFixed(4)} | ${rank} | ${flag} |`,
      );
    }
  }
  L.push("");
  L.push("## Agregat per model x clasa");
  L.push("");
  L.push("| model | clasa | n | TTFT mediu | total mediu | cost mediu | cost total | rank mediu | wins | losses | flagged |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const model of MODELS)
    for (const cls of ["easy", "hard"]) {
      const a = agg[model][cls];
      if (!a.n) {
        L.push(`| ${model} | ${cls} | 0 | — | — | — | — | — | — | — | — |`);
        continue;
      }
      L.push(
        `| ${model} | ${cls} | ${a.n} | ${fmtMs(Math.round(avg(a, "ttft")))} | ${fmtMs(Math.round(avg(a, "total")))} | $${avg(a, "cost").toFixed(4)} | $${a.cost.toFixed(4)} | ${avgRank(a)} | ${a.wins} | ${a.losses} | ${a.flagged} |`,
      );
    }
  L.push("");
  L.push("## Note de judecata (blind, per intrebare)");
  for (const c of QUESTIONS) {
    const j = judgments[c.id];
    if (!j) continue;
    L.push(
      `- **${c.id}** (${c.cls}): ${j.ranking.map((l) => j.mapping[l]).join(" > ")}${
        (j.any_wrong_or_shallow ?? []).length
          ? ` · flagged: ${j.any_wrong_or_shallow.map((l) => j.mapping[l]).join(", ")}`
          : ""
      } — ${String(j.notes ?? "").slice(0, 400)}`,
    );
  }

  /* verdict */
  const sol = agg["gpt-6-sol"],
    luna = agg["gpt-6-luna"],
    g5 = agg["gpt-5"];
  L.push("");
  L.push("## VERDICT");
  const line = (name, a, b, cls) => {
    if (!a[cls].n) return `- **${name} on ${cls.toUpperCase()}**: model unavailable — no data.`;
    return (
      `- **${name} on ${cls.toUpperCase()}**: rank mediu ${avgRank(a[cls])} vs gpt-5 ${avgRank(b[cls])}; ` +
      `wins ${a[cls].wins} vs ${b[cls].wins}; flagged ${a[cls].flagged} vs ${b[cls].flagged}; ` +
      `TTFT ${fmtMs(Math.round(avg(a[cls], "ttft")))} vs ${fmtMs(Math.round(avg(b[cls], "ttft")))}; ` +
      `cost mediu $${avg(a[cls], "cost").toFixed(4)} vs $${avg(b[cls], "cost").toFixed(4)}.`
    );
  };
  L.push(line("Sol vs gpt-5", sol, g5, "hard"));
  L.push(line("Sol vs gpt-5", sol, g5, "easy"));
  L.push(line("Luna vs gpt-5", luna, g5, "easy"));
  L.push(line("Luna vs gpt-5", luna, g5, "hard"));
  L.push("");
  L.push("### Recomandare rutare");
  L.push("_(completata manual dupa citirea cifrelor de mai sus — vezi raportul agentului)_");
  L.push("");

  fs.mkdirSync(path.join(__dirname, "..", "eval"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "eval", "results-models.md"), L.join("\n"));
  console.log("\nwritten eval/results-models.md");
  console.log(`run cache: ${CACHE_FILE}`);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
