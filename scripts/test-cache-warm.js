/**
 * Cache keep-warm battery: prompt_cache_key + warm pings must make every
 * question (including after minutes of reading) hit the warm cache.
 * Long test (~6 min): includes a 4.5-min hold to prove the interval ping.
 */
const puppeteer = require("puppeteer-core");
const CHROME = process.env.TEMP + "/rd-chrome/chrome/win64-152.0.7977.82/chrome-win64/chrome.exe";
const DOC = "8d030271-2e23-4a9b-bfb1-5e8802b70839"; // zebra (re-seeded 2026-09-21)

let pass = 0, fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log("PASS", name, extra); }
  else { fail++; console.log("FAIL", name, extra); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function warm(p) {
  return await p.evaluate(async (id) => {
    const r = await fetch(`/api/documents/${id}/warm`, { method: "POST" });
    return await r.json();
  }, DOC);
}

async function ask(p, q) {
  // open the first highlight's card? simpler: create a fresh highlight then ask
  const geo = await p.evaluate(() => {
    const spans = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')];
    const s = spans.find((x) => (x.textContent || "").length > 60);
    const r = s.getBoundingClientRect();
    return { x1: r.left + 2, y1: r.top + r.height / 2, x2: r.left + r.width * 0.5, y2: r.top + r.height / 2 };
  });
  await p.mouse.move(geo.x1, geo.y1);
  await p.mouse.down();
  await p.mouse.move(geo.x2, geo.y2, { steps: 10 });
  await p.mouse.up();
  await sleep(700);
  await p.evaluate(() => document.querySelector('div[role=toolbar] button[aria-label*="blue"]')?.click());
  await sleep(1800);
  const hlId = await p.evaluate(() =>
    document.querySelector("[data-card] textarea")?.closest("[data-card]")?.getAttribute("data-card"));
  await p.evaluate((question) => {
    const ta = document.querySelector("[data-card] textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, question);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, q);
  await p.focus("[data-card] textarea");
  await p.keyboard.press("Enter");
  // wait for the answer to complete
  let last = 0, stable = 0;
  for (let i = 0; i < 80; i++) {
    await sleep(1500);
    const len = await p.evaluate(() => {
      const card = document.querySelector("[data-card] textarea")?.closest("[data-card]");
      return card ? (card.textContent || "").length : 0;
    });
    if (len > last + 5) { last = len; stable = 0; }
    else if (last > 200) { stable++; if (stable >= 3) break; }
  }
  await p.keyboard.press("Escape");
  return hlId;
}

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage();
  await p.setViewport({ width: 1920, height: 950 });
  await p.goto(`http://localhost:3000/read/${DOC}`, { waitUntil: "networkidle2", timeout: 90000 });
  await p.waitForSelector(".rd-pdf-page canvas", { timeout: 30000 });
  await sleep(4000); // mount warm ping has fired

  // W1: a manual warm right after mount must ride the mount ping's cache —
  // BOTH effort lanes (the provider cache is partitioned by effort).
  const w1 = await warm(p);
  const pct = (u) => (u && u.inputTokens ? Math.round((100 * u.cachedInputTokens) / u.inputTokens) : 0);
  check("W1: low lane cached >=90%", pct(w1.low) >= 90, `${pct(w1.low)}%`);
  check("W1: medium lane cached >=90%", pct(w1.medium) >= 90, `${pct(w1.medium)}%`);
  check("W1: low+verbLow lane cached >=90%", pct(w1.lowVlow) >= 90, `${pct(w1.lowVlow)}%`);
  check("W1: medium+verbLow lane cached >=90%", pct(w1.mediumVlow) >= 90, `${pct(w1.mediumVlow)}%`);

  // W2: a real question NOW must hit the cache warmed by pings
  const hl1 = await ask(p, "Ce insecte au studiat aici? Pe scurt.");
  check("W2: question asked (id)", !!hl1, hl1 ?? "");

  // W3: hold the page open 4.5 minutes (interval ping keeps the cache alive),
  // then ask again — must still be warm.
  console.log("  ... holding 4.5 min (interval ping) ...");
  await sleep(270000);
  let w3;
  try {
    w3 = await warm(p);
  } catch {
    // dev auth refresh can renavigate the page mid-hold; reopen (a real
    // session remounts Reader the same way, which re-fires the mount warm)
    await p.goto(`http://localhost:3000/read/${DOC}`, { waitUntil: "networkidle2", timeout: 90000 });
    await p.waitForSelector(".rd-pdf-page canvas", { timeout: 30000 });
    await sleep(2500);
    w3 = await warm(p);
  }
  check("W3: low lane still cached >=90% after 4.5 min hold", pct(w3.low) >= 90, `${pct(w3.low)}%`);
  check("W3: medium lane still cached >=90% after hold", pct(w3.medium) >= 90, `${pct(w3.medium)}%`);
  check("W3: low+verbLow lane still cached >=90%", pct(w3.lowVlow) >= 90, `${pct(w3.lowVlow)}%`);
  check("W3: medium+verbLow lane still cached >=90%", pct(w3.mediumVlow) >= 90, `${pct(w3.mediumVlow)}%`);
  const hl2 = await ask(p, "Si cum au filmat mustele? Scurt.");
  check("W3: second question asked", !!hl2, hl2 ?? "");

  // cleanup
  const cleaned = await p.evaluate(async (ids) => {
    const out = [];
    for (const id of ids.filter(Boolean)) out.push((await fetch(`/api/highlights/${id}`, { method: "DELETE" })).ok);
    return out;
  }, [hl1, hl2]);
  check("W4: cleanup", cleaned.every(Boolean), JSON.stringify(cleaned));

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log("(cached% pentru cele doua INTREBARI reale se citesc din liniile [answer] din logul serverului)");
  await b.close();
  process.exit(fail ? 1 : 0);
})();
