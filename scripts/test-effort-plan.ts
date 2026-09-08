/**
 * Planner battery: labeled questions -> {web, effort, verbosity}. Asymmetric
 * rules: UNDER-dosing effort = FAIL, over-dosing = warning (quality-first).
 * The depth-guard cases must force effort=high deterministically.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const ORDER = { low: 0, medium: 1, high: 2 } as const;
type D = keyof typeof ORDER;

interface Case { q: string; minEffort: D; maxEffort?: D; web?: boolean }

const CASES: Case[] = [
  // low is fine (over-dose = warn)
  { q: "what does 'senescence' mean?", minEffort: "low", maxEffort: "medium" },
  { q: "tradu 'healthspan' in romana", minEffort: "low", maxEffort: "medium" },
  { q: "pe ce pagina vorbeste despre mitocondrii?", minEffort: "low", maxEffort: "medium" },
  { q: "what year range do they mention for life expectancy?", minEffort: "low", maxEffort: "medium" },
  // interpretive -> at least medium
  { q: "explain what this passage is saying", minEffort: "medium" },
  { q: "de ce cred autorii ca imbatranirea e modificabila?", minEffort: "medium" },
  { q: "how does this claim relate to the previous section?", minEffort: "medium" },
  { q: "si asta ce vrea sa zica?", minEffort: "medium" },
  // heavy analysis -> medium (calibrat pe date: high doar la cererea explicita
  // a cititorului — planner-high nu cumpara calitate, doar cost)
  { q: "verify whether the conclusion actually follows from the evidence they present, and list the weakest links", minEffort: "medium", maxEffort: "medium" },
  { q: "critica metodologia articolului: ce lipseste ca sa fie concludent?", minEffort: "medium", maxEffort: "medium" },
  { q: "synthesize how the theme of death connects to the present moment across the whole book", minEffort: "medium", maxEffort: "medium" },
  // depth-guard (deterministic): must be high
  { q: "n-am inteles, explica mai profund", minEffort: "high" },
  { q: "I didn't understand your answer, explain more in depth", minEffort: "high" },
  // web
  { q: "who is the author, is she legit?", minEffort: "low", web: true },
  { q: "was this replicated by other labs?", minEffort: "low", web: true },
  { q: "what does the article conclude?", minEffort: "medium", web: false },
];

async function main() {
  const { planRequest } = await import("../lib/answer");
  let pass = 0, fail = 0, warn = 0;
  for (const c of CASES) {
    const p = await planRequest(c.q, "Do you want to live forever? Lessons from the biology of aging");
    const problems: string[] = [];
    if (ORDER[p.effort] < ORDER[c.minEffort]) problems.push(`effort ${p.effort} < min ${c.minEffort}`);
    if (c.web !== undefined && p.web !== c.web) problems.push(`web=${p.web} expected ${c.web}`);
    const over = c.maxEffort && ORDER[p.effort] > ORDER[c.maxEffort];
    const desc = `effort=${p.effort} verb=${p.verbosity} web=${p.web}`;
    if (problems.length) { fail++; console.log(`FAIL ${problems.join("; ")} :: ${desc} :: ${c.q.slice(0, 60)}`); }
    else if (over) { warn++; pass++; console.log(`PASS (over-dozat, acceptabil) :: ${desc} :: ${c.q.slice(0, 60)}`); }
    else { pass++; console.log(`PASS :: ${desc} :: ${c.q.slice(0, 60)}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed, ${warn} over-dozari`);
  process.exit(fail ? 1 : 0);
}
void main();
