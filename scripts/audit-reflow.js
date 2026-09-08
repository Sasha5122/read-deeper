/**
 * AUDIT C — reflow view (EPUB/TXT/MOBI/HTML docs, no PDF): select text →
 * palette → highlight + chat card → persistence → delete.
 */
const puppeteer = require("puppeteer-core");
const CHROME = process.env.TEMP + "/rd-chrome/chrome/win64-152.0.7977.82/chrome-win64/chrome.exe";
const DOC = process.argv[2]; // an epub/txt document id

let pass = 0, fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log("PASS", name, extra); }
  else { fail++; console.log("FAIL", name, extra); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!DOC) { console.error("usage: node audit-reflow.js <docId>"); process.exit(2); }
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage();
  await p.setViewport({ width: 1920, height: 950 });

  async function open() {
    await p.goto(`http://localhost:3000/read/${DOC}`, { waitUntil: "networkidle2", timeout: 90000 });
    await p.waitForSelector(".rd-page", { timeout: 30000 });
    await sleep(1500);
  }
  await open();
  await p.evaluate(() => localStorage.clear());

  check("R0: capture tool hidden in reflow view",
    await p.evaluate(() => ![...document.querySelectorAll("header button")].some((x) => x.textContent.includes("Capture"))));

  // R1: drag-select inside a paragraph
  const geo = await p.evaluate(() => {
    const paras = [...document.querySelectorAll(".reading-column p")];
    const t = paras.find((x) => (x.textContent || "").length > 120);
    if (!t) return null;
    const range = document.createRange();
    range.selectNodeContents(t);
    const r = range.getClientRects()[0];
    return { x1: r.left + 2, y1: r.top + r.height / 2, x2: r.left + Math.min(r.width * 0.6, 500), y2: r.top + r.height / 2 };
  });
  check("R1: paragraph found", !!geo);
  await p.mouse.move(geo.x1, geo.y1);
  await p.mouse.down();
  await p.mouse.move(geo.x2, geo.y2, { steps: 12 });
  await p.mouse.up();
  await sleep(700);
  check("R1: palette appears", await p.evaluate(() => !!document.querySelector("[data-seltoolbar]")));

  // R2: pick blue -> <mark> in the text + open card
  const before = await p.evaluate(() => document.querySelectorAll("mark.hl[data-hl]").length);
  await p.evaluate(() => document.querySelector('div[role=toolbar] button[aria-label*="blue"]')?.click());
  await sleep(1800);
  const marks = await p.evaluate(() => {
    const ms = [...document.querySelectorAll("mark.hl[data-hl]")];
    const ids = [...new Set(ms.map((m) => m.getAttribute("data-hl")))].filter((x) => !x.startsWith("s-"));
    return { count: ms.length, ids };
  });
  check("R2: highlight mark rendered in text", marks.count > before, `${before} -> ${marks.count}`);
  check("R2: chat card opened", await p.evaluate(() => !!document.querySelector("[data-card] textarea")));
  const newId = await p.evaluate(() => {
    const card = document.querySelector("[data-card] textarea")?.closest("[data-card]");
    return card?.getAttribute("data-card") ?? null;
  });
  check("R2: card bound to a highlight", !!newId, newId ?? "");

  // R3: persistence
  await open();
  const persisted = await p.evaluate((id) => !!document.querySelector(`mark.hl[data-hl="${id}"]`), newId);
  check("R3: highlight survives reload", persisted);

  // R4: click the mark -> card opens; delete removes it
  await p.evaluate((id) => document.querySelector(`mark.hl[data-hl="${id}"]`)?.click(), newId);
  await sleep(900);
  check("R4: clicking the mark opens its chat", await p.evaluate(() => !!document.querySelector("[data-card] textarea")));
  await p.evaluate(() => document.querySelector('[data-card] button[aria-label="Delete highlight and thread"]')?.click());
  await sleep(1500);
  check("R4: delete removes the mark", await p.evaluate((id) => !document.querySelector(`mark.hl[data-hl="${id}"]`), newId));

  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
