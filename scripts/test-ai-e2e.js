/**
 * AI end-to-end battery, through the real UI with REAL answers:
 * highlight -> Explain (streamed) -> persistence -> typed document question ->
 * AI search with page jump -> capture region -> vision answer. Cleans up.
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
  } catch {
    // detached frame during an HMR reload â€” treat as "no reading this tick"
    return null;
  }
}

/**
 * Wait until the expanded card's text stops growing. Reasoning models can
 * think silently for 30-90s before the first token, so the clock for
 * stability starts only once growth is observed.
 */
async function waitAnswer(p, baseLen, timeoutMs = 240000, minGrowth = 160) {
  // minGrowth must exceed the echoed user question so the silent reasoning
  // period (30-90s before the first token) is not mistaken for completion.
  const t0 = Date.now();
  let last = baseLen;
  let stable = 0;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1500);
    const text = await cardText(p);
    if (text === null) continue;
    const len = text.length;
    if (len > last + 5) { last = len; stable = 0; }
    else if (len > baseLen + minGrowth) { stable++; if (stable >= 4) return len; }
  }
  return last;
}

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage();
  await p.setViewport({ width: 1920, height: 950 });
  const errors = [];
  p.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  async function open() {
    await p.goto(`http://localhost:3000/read/${DOC}`, { waitUntil: "networkidle2", timeout: 90000 });
    await p.waitForSelector(".rd-pdf-page canvas", { timeout: 30000 });
    await sleep(2800);
  }
  await open();
  await p.evaluate(() => localStorage.clear());

  /* ---- 1. highlight + Explain (streamed real answer) ---- */
  const geo = await p.evaluate(() => {
    const spans = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')];
    const s = spans.find((x) => (x.textContent || "").includes("Readers of contracts"));
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return { x1: r.left + 2, y1: r.top + r.height / 2, x2: r.left + r.width * 0.7, y2: r.top + r.height / 2 };
  });
  await p.mouse.move(geo.x1, geo.y1);
  await p.mouse.down();
  await p.mouse.move(geo.x2, geo.y2, { steps: 12 });
  await p.mouse.up();
  await sleep(700);
  await p.evaluate(() => document.querySelector('div[role=toolbar] button[aria-label*="amber"]')?.click());
  await sleep(2000);
  const hlId = await p.evaluate(() =>
    document.querySelector("[data-card] textarea")?.closest("[data-card]")?.getAttribute("data-card"));
  check("E1: highlight + card created", !!hlId, hlId ?? "");

  const base1 = ((await cardText(p)) ?? "").length;
  await p.evaluate(() => {
    [...document.querySelectorAll("[data-card] button")].find((x) => x.textContent.trim() === "Explain").click();
  });
  const len1 = await waitAnswer(p, base1);
  const text1 = (await cardText(p)) ?? "";
  check("E1: Explain streams a real answer", len1 > base1 + 100, `${len1 - base1} chars`);
  check("E1: no error banner", await p.evaluate(() => !document.querySelector("header .text-red-700")));
  check("E1: answer engages the passage", /structur|vocabular|contract|clause|local/i.test(text1),
    text1.slice(base1, base1 + 90).replace(/\s+/g, " "));

  /* ---- 2. persistence after reload ---- */
  await open();
  await p.evaluate((id) => {
    const d = document.querySelector(`.pdf-overlay[data-owner="${id}"]`);
    if (!d) return;
    const r = d.getBoundingClientRect();
    document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
  }, hlId);
  await sleep(1200);
  const persisted = (await cardText(p)) ?? "";
  check("E2: AI answer persists after reload", persisted.length > 150, `${persisted.length} chars`);

  /* ---- 3. typed document-level question ---- */
  const base3 = persisted.length;
  await p.evaluate(() => {
    const ta = document.querySelector("[data-card] textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, "Care e concluzia principala a articolului si pe ce rezultate se sprijina?");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await p.focus("[data-card] textarea");
  await p.keyboard.press("Enter");
  const len3 = await waitAnswer(p, base3, 240000, 260);
  const text3 = (await cardText(p)) ?? "";
  check("E3: document-level answer streams", len3 > base3 + 150, `${len3 - base3} chars`);
  check("E3: answers in Romanian (asked language)", /â€ž|conclu|Ã®mbunÄƒtÄƒÈ›|imbunatat|rezultat|comprehensiune|Ã®nÈ›eleg/i.test(text3.slice(base3)));

  /* ---- 4. AI search with page jump ---- */
  await p.keyboard.press("Escape");
  await sleep(400);
  await p.evaluate(() => {
    [...document.querySelectorAll("header button")].find((x) => x.textContent.includes("AI search")).click();
  });
  await p.waitForSelector('div[role=dialog][aria-label="Find by meaning"] textarea', { timeout: 8000 });
  await p.type('div[role=dialog][aria-label="Find by meaning"] textarea', "unde descriu grupurile de participanti si conditiile experimentului");
  await p.keyboard.press("Enter");
  let searchDone = "";
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const st = await p.evaluate(() => {
      const dlg = document.querySelector('div[role=dialog][aria-label="Find by meaning"]');
      if (!dlg) return { text: "", busy: false };
      const busy = [...dlg.querySelectorAll("button")].some((x) => x.textContent.includes("Searching"));
      return { text: dlg.textContent || "", busy };
    });
    searchDone = st.text;
    if (!st.busy && st.text.length > 300) break;
  }
  check("E4: AI search returns an answer", /\(p\.\s*\d/.test(searchDone), searchDone.slice(0, 80).replace(/\s+/g, " "));
  const jumped = await p.evaluate(() => {
    const dlg = document.querySelector('div[role=dialog][aria-label="Find by meaning"]');
    const btn = dlg && [...dlg.querySelectorAll("button")].find((x) => /^p\.\s*\d+$/.test(x.textContent.trim()));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(1500);
  // NON-MODAL by design (2026-09-23): jumps scroll the document while the
  // results stay open; outside-click close is REMOVED — only ✕/Escape close.
  check("E4: page-jump button exists and dialog STAYS open", jumped &&
    (await p.evaluate(() => !!document.querySelector('div[role=dialog][aria-label="Find by meaning"]'))));
  await p.keyboard.press("Escape");
  await sleep(600);
  check("E4: Escape closes the dialog", await p.evaluate(() =>
    !document.querySelector('div[role=dialog][aria-label="Find by meaning"]')));

  /* ---- 5. capture region + VISION answer ---- */
  // The bar chart sits right under the "Figure 1 summarises..." paragraph —
  // scroll that line into view and frame the area just below it.
  const figAnchor = await p.evaluate(() => {
    const span = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')]
      .find((s) => (s.textContent || "").includes("Figure 1 summarises"));
    if (!span) return null;
    span.scrollIntoView({ block: "start" });
    return true;
  });
  check("E5: figure anchor found", !!figAnchor);
  await sleep(1500);
  await p.evaluate(() => {
    [...document.querySelectorAll("header button")].find((x) => /Capture|Draw a box/.test(x.textContent)).click();
  });
  await sleep(900);
  const r = await p.evaluate(() => {
    const span = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')]
      .find((s) => (s.textContent || "").includes("Figure 1 summarises"));
    const b = span.getBoundingClientRect();
    const page = document.querySelector('[data-page="1"]').getBoundingClientRect();
    return { left: page.left + page.width * 0.1, top: b.bottom + 12, width: page.width, height: 0 };
  });
  await p.mouse.move(r.left, Math.min(r.top, 900));
  await p.mouse.down();
  await p.mouse.move(r.left + r.width * 0.42, Math.min(r.top + 170, 940), { steps: 10 });
  await p.mouse.up();
  await sleep(600);
  // palette opens directly after framing; picking a colour goes straight to the chat
  await p.evaluate(() => document.querySelector('button[aria-label="Capture in green"]')?.click());
  await sleep(2500);
  const regionId = await p.evaluate(() =>
    document.querySelector("[data-card] textarea")?.closest("[data-card]")?.getAttribute("data-card"));
  check("E5: region + card created", !!regionId, regionId ?? "");
  const base5 = ((await cardText(p)) ?? "").length;
  await p.evaluate(() => {
    const ta = document.querySelector("[data-card] textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, "Ce arata exact aceasta zona capturata? Descrie ce vezi.");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await p.focus("[data-card] textarea");
  await p.keyboard.press("Enter");
  const len5 = await waitAnswer(p, base5, 240000);
  check("E5: vision answer streams", len5 > base5 + 100, `${len5 - base5} chars`);
  // Content check with retries + fresh reopen — immune to HMR reloads mid-poll.
  let vision = "";
  for (let i = 0; i < 5 && vision.length < 100; i++) {
    await sleep(1200);
    vision = (await cardText(p)) ?? "";
  }
  if (vision.length < 100) {
    await open();
    await p.evaluate((rid) => {
      const d = document.querySelector(`.pdf-overlay[data-owner="${rid}"]`);
      if (!d) return;
      const rr = d.getBoundingClientRect();
      const sc = [...document.querySelectorAll("div")].find((v) => v.scrollHeight > v.clientHeight + 200 && v.clientHeight > 500);
      sc.scrollTop += rr.top + rr.height / 2 - window.innerHeight / 2;
    }, regionId);
    await sleep(1200);
    await p.evaluate((rid) => {
      const d = document.querySelector(`.pdf-overlay[data-owner="${rid}"]`);
      if (!d) return;
      const rr = d.getBoundingClientRect();
      document.elementFromPoint(rr.left + rr.width / 2, rr.top + rr.height / 2)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: rr.left + rr.width / 2, clientY: rr.top + rr.height / 2 }));
    }, regionId);
    await sleep(1500);
    vision = (await cardText(p)) ?? "";
  }
  check("E5: vision answer describes the captured pixels",
    /grafic|figur|bar |bare|axa|accuracy|acurate|rând|rand|text|decup|văd|se vede/i.test(vision),
    vision.slice(-140).replace(/\s+/g, " "));

  try { await p.screenshot({ path: "v-ai-e2e.png" }); } catch { console.log("(screenshot skipped)"); }

  /* ---- cleanup via API (deterministic, UI-state independent) ---- */
  const cleaned = await p.evaluate(async (rid, hid) => {
    const out = [];
    if (rid) out.push((await fetch(`/api/regions/${rid}`, { method: "DELETE" })).ok);
    if (hid) out.push((await fetch(`/api/highlights/${hid}`, { method: "DELETE" })).ok);
    return out;
  }, regionId, hlId);
  check("E6: cleanup complete", cleaned.every(Boolean), JSON.stringify(cleaned));
  check("E7: no page errors", errors.length === 0, errors[0] ?? "");

  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
