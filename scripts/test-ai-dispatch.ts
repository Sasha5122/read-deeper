/**
 * Dispatcher battery: labeled questions -> assert the routing ticket respects
 * the quality-first calibration. Rules:
 *  - an interpretive question must NEVER land on "lookup" (under-escalation)
 *  - document-level questions must fetch RAG chunks
 *  - outside-knowledge questions must enable web
 *  - over-escalation is allowed (bias up), logged as a warning
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const ORDER = { lookup: 0, passage: 1, document: 2, research: 3 } as const;
type TierName = keyof typeof ORDER;

interface Case {
  name: string;
  question: string;
  quote?: string;
  historyCount?: number;
  minTier: TierName;
  maxTier?: TierName;
  needsRag?: boolean;
  needsWeb?: boolean;
}

const QUOTE_DEFAULT =
  "the control condition consumed 2.4× more tokens per resolved question while scoring lower";

const CASES: Case[] = [
  // --- trivial: lookup is fine (but bias-up is not an error) ---
  { name: "sinonim", question: "un sinonim pentru 'comprehension'?", minTier: "lookup", maxTier: "passage" },
  { name: "traducere", question: "tradu 'reconstruction cost' in romana", minTier: "lookup", maxTier: "passage" },
  { name: "definitie", question: "ce inseamna cuvantul 'locality' aici?", minTier: "lookup", maxTier: "passage" },
  // --- interpretive: must NOT be lookup ---
  { name: "explica", question: "explica-mi pasajul asta mai simplu", minTier: "passage" },
  { name: "de-ce", question: "de ce ar consuma controlul de 2.4 ori mai multe tokens?", minTier: "passage" },
  { name: "exemplu", question: "da-mi un exemplu concret la ce zice aici", minTier: "passage" },
  { name: "ambigua", question: "si asta ce vrea sa zica?", minTier: "passage" },
  // --- document-level: needs retrieval ---
  {
    name: "cross-sectiune",
    question: "cum se leaga afirmatia asta de sectiunea de metode a articolului?",
    minTier: "document",
    needsRag: true,
  },
  {
    name: "concluzie-globala",
    question: "care e concluzia principala a articolului si pe ce rezultate se sprijina?",
    minTier: "document",
    needsRag: true,
  },
  // --- research: heavy multi-step ---
  {
    name: "verificare",
    question:
      "verifica daca concluzia din discutie chiar decurge din rezultatele raportate in tabelul 2 si spune-mi ce limite metodologice are studiul",
    minTier: "document",
    needsRag: true,
  },
  // --- web ---
  {
    name: "replicare",
    question: "a fost replicat studiul asta de alti cercetatori?",
    minTier: "passage",
    needsWeb: true,
  },
  {
    name: "context-conversatie",
    question: "revenind la ce ziceai mai devreme, totusi de ce e mai scump?",
    historyCount: 8,
    minTier: "passage",
  },
];

async function main() {
  const { dispatch } = await import("../lib/dispatcher");
  let pass = 0,
    fail = 0,
    warn = 0;

  for (const c of CASES) {
    const { ticket, fallback } = await dispatch({
      question: c.question,
      quote: c.quote ?? QUOTE_DEFAULT,
      docTitle: "Margin-Anchored AI Assistance and Reading Comprehension",
      meta: {
        doc_type: "scientific_article",
        language: "en",
        domain: "human-computer interaction",
        key_entities: [],
        structure: [],
      },
      historyCount: c.historyCount ?? 0,
      isRegion: false,
    });
    const problems: string[] = [];
    if (fallback) problems.push("dispatcher fell back");
    if (ORDER[ticket.tier] < ORDER[c.minTier]) problems.push(`tier ${ticket.tier} < min ${c.minTier}`);
    if (c.needsRag && ticket.rag_chunks === 0) problems.push("rag_chunks=0 but retrieval needed");
    if (c.needsWeb && !ticket.web) problems.push("web=false but outside knowledge needed");
    const over = c.maxTier && ORDER[ticket.tier] > ORDER[c.maxTier];

    const desc = `tier=${ticket.tier} surround=${ticket.surrounding} conv=${ticket.conversation} rag=${ticket.rag_chunks} web=${ticket.web} len=${ticket.answer_length}`;
    if (problems.length > 0) {
      fail++;
      console.log(`FAIL ${c.name}: ${problems.join("; ")} :: ${desc}`);
    } else if (over) {
      warn++;
      pass++;
      console.log(`PASS ${c.name} (over-escalated, acceptabil) :: ${desc}`);
    } else {
      pass++;
      console.log(`PASS ${c.name} :: ${desc}`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed, ${warn} over-escalations`);
  process.exit(fail ? 1 : 0);
}
void main();
