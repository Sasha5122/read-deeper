/**
 * Markdown-in-card verification: a real answer with formatting must render
 * as bold/lists (no literal ** or #), the Thinking indicator must show before
 * the first token, and the full-viewport screenshot proves the layout.
 */
const puppeteer = require("puppeteer-core");
const CHROME = process.env.TEMP + "/rd-chrome/chrome/win64-152.0.7977.82/chrome-win64/chrome.exe";
const DOC = "27f352a4-bb4c-4074-a3d7-96a72841a90f";

let pass = 0, fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log("PASS", name, extra); }
  else { fail++; console.log("FAIL", name, extra); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage();
  await p.setViewport({ width: 1920, height: 950 });
  await p.goto(`http://localhost:3000/read/${DOC}`, { waitUntil: "networkidle2", timeout: 90000 });
  await p.waitForSelector(".rd-pdf-page canvas", { timeout: 30000 });
  await sleep(2800);

  // highlight a sentence
  const geo = await p.evaluate(() => {
    const spans = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')];
    const s = spans.find((x) => (x.textContent || "").includes("Readers of contracts"));
    const r = s.getBoundingClientRect();
    return { x1: r.left + 2, y1: r.top + r.height / 2, x2: r.left + r.width * 0.7, y2: r.top + r.height / 2 };
  });
  await p.mouse.move(geo.x1, geo.y1);
  await p.mouse.down();
  await p.mouse.move(geo.x2, geo.y2, { steps: 12 });
  await p.mouse.up();
  await sleep(700);
  await p.evaluate(() => document.querySelector('div[role=toolbar] button[aria-label*="amber"]')?.click());
  await sleep(1800);
  const hlId = await p.evaluate(() =>
    document.querySelector("[data-card] textarea")?.closest("[data-card]")?.getAttribute("data-card"));
  check("M1: card open", !!hlId);

  // question engineered to produce markdown structure
  await p.evaluate(() => {
    const ta = document.querySelector("[data-card] textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, "Care sunt cele 3 idei principale ale acestui pasaj? Marcheaza termenii cheie cu bold.");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await p.focus("[data-card] textarea");
  await p.keyboard.press("Enter");

  // Thinking indicator before first token
  let sawThinking = false;
  for (let i = 0; i < 20 && !sawThinking; i++) {
    sawThinking = await p.evaluate(() => {
      const card = document.querySelector("[data-card] textarea")?.closest("[data-card]");
      return (card?.textContent || "").includes("Thinking");
    });
    if (!sawThinking) await sleep(300);
  }
  check("M2: Thinking indicator shows before first token", sawThinking);

  // wait for the full answer
  const t0 = Date.now();
  let text = "", last = 0, stable = 0;
  while (Date.now() - t0 < 180000) {
    await sleep(1500);
    text = await p.evaluate(() => {
      const card = document.querySelector("[data-card] textarea")?.closest("[data-card]");
      return card ? card.textContent || "" : "";
    });
    if (text.length > last + 5) { last = text.length; stable = 0; }
    else if (last > 300 && !text.includes("Thinking")) { stable++; if (stable >= 3) break; }
  }
  check("M3: answer arrived", last > 300, `${last} chars`);
  const md = await p.evaluate(() => {
    const card = document.querySelector("[data-card] textarea")?.closest("[data-card]");
    if (!card) return null;
    return {
      rawStars: /\*\*/.test(card.textContent || ""),
      rawHashes: /(^|\n)#{1,4} /.test(card.textContent || ""),
      bolds: card.querySelectorAll("strong").length,
      lists: card.querySelectorAll("ul,ol").length,
    };
  });
  check("M4: no literal ** in the card", md && !md.rawStars);
  check("M4: no literal # headings", md && !md.rawHashes);
  check("M4: real bold elements rendered", md && md.bolds > 0, `strong=${md?.bolds} lists=${md?.lists}`);
  await p.screenshot({ path: "v-markdown-card.png" });

  // cleanup
  const ok = await p.evaluate(async (id) => (await fetch(`/api/highlights/${id}`, { method: "DELETE" })).ok, hlId);
  check("M5: cleanup", ok);

  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
