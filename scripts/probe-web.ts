/** Dev probe: true latency + accuracy of the V2 web classifier (no timeout clamp). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
process.env.WEB_CLASSIFIER_TIMEOUT_MS = "10000";

async function main() {
  const { classifyWeb } = await import("../lib/answer");
  const qs: [string, boolean][] = [
    ["who is William B. Mair? is he a legit scientist?", true],
    ["was this study replicated by anyone?", true],
    ["what does this passage mean?", false],
    ["explain the conclusion of the article", false],
  ];
  for (const [q, expect] of qs) {
    const t0 = Date.now();
    const web = await classifyWeb(q, "Do you want to live forever?");
    console.log(`${Date.now() - t0}ms web=${web} expect=${expect} ${web === expect ? "OK" : "MISS"} :: ${q.slice(0, 50)}`);
  }
}
void main();
