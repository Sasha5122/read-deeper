/**
 * Regression for the reported bug: on a CAPTURE (region) thread the streamed
 * answer used to vanish the moment the stream finished. Assert it STAYS in
 * the card after completion, with no reload.
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

async function cardText(p) {
  try {
    return await p.evaluate(() => {
      const card = document.querySelector("[data-card] textarea")?.closest("[data-card]");
      return card ? card.textContent || "" : "";
    });
  } catch { return null; }
}

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage();
  await p.setViewport({ width: 1920, height: 950 });
  await p.goto(`http://localhost:3000/read/${DOC}`, { waitUntil: "networkidle2", timeout: 90000 });
  await p.waitForSelector(".rd-pdf-page canvas", { timeout: 30000 });
  await sleep(2800);

  // capture a rect on page 1
  await p.evaluate(() => {
    [...document.querySelectorAll("header button")].find((x) => /Capture|Draw a box/.test(x.textContent)).click();
  });
  await sleep(900);
  const r = await p.evaluate(() => {
    const bb = document.querySelector('[data-page="1"]').getBoundingClientRect();
    const top = Math.max(bb.top, 60);
    return { left: bb.left, top, width: bb.width };
  });
  await p.mouse.move(r.left + r.width * 0.2, r.top + 200);
  await p.mouse.down();
  await p.mouse.move(r.left + r.width * 0.6, r.top + 340, { steps: 10 });
  await p.mouse.up();
  await sleep(600);
  await p.evaluate(() => document.querySelector('button[aria-label="Choose a colour for this capture"]')?.click());
  await sleep(400);
  await p.evaluate(() => document.querySelector('button[aria-label="Capture in blue"]')?.click());
  await sleep(2500);
  await p.evaluate(() => document.querySelector('div[role=dialog][aria-label="Captured area"] button[aria-label="Close"]')?.click());
  await sleep(1000);
  const regionId = await p.evaluate(() =>
    document.querySelector("[data-card] textarea")?.closest("[data-card]")?.getAttribute("data-card"));
  check("R1: region card open", !!regionId, regionId ?? "");

  const base = ((await cardText(p)) ?? "").length;
  const QUESTION = "Ce vezi in aceasta zona? Pe scurt.";
  await p.evaluate((q) => {
    const ta = document.querySelector("[data-card] textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, q);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, QUESTION);
  await p.focus("[data-card] textarea");
  await p.keyboard.press("Enter");

  // wait for a substantial answer beyond the echoed question
  const minGrowth = QUESTION.length + 120;
  const t0 = Date.now();
  let len = base, stable = 0;
  while (Date.now() - t0 < 240000) {
    await sleep(1500);
    const t = await cardText(p);
    if (t === null) continue;
    if (t.length > len + 5) { len = t.length; stable = 0; }
    else if (t.length > base + minGrowth) { stable++; if (stable >= 4) break; }
  }
  check("R2: answer streamed into the card", len > base + minGrowth, `+${len - base} chars`);

  // THE BUG: text used to vanish right when the stream finished.
  await sleep(6000);
  const after = (await cardText(p)) ?? "";
  check("R3: answer STAYS after the stream ends (no vanish)", after.length >= base + minGrowth,
    `now ${after.length - base} chars beyond base`);
  await sleep(4000);
  const later = (await cardText(p)) ?? "";
  check("R3b: still there 10s later", later.length >= base + minGrowth);

  // cleanup
  const ok = await p.evaluate(async (rid) => (await fetch(`/api/regions/${rid}`, { method: "DELETE" })).ok, regionId);
  check("R4: cleanup", ok);

  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
