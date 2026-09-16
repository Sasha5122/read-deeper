/**
 * Highlight overlay PRECISION battery — verifies the Range.getBoundingClientRect
 * overlay fix: partial-span highlights must sit exactly on the selected glyphs
 * (<=2px left/right) even in the LARGE title font, where the old proportional
 * character math drifted. Also: conversation-starter buttons only on empty
 * threads, full-viewport screenshot, API cleanup.
 */
const puppeteer = require("puppeteer-core");
const CHROME = process.env.TEMP + "/rd-chrome/chrome/win64-152.0.7977.82/chrome-win64/chrome.exe";
const DOC = "75a00f21-7549-490f-85e4-39cc703c7f48";

let pass = 0, fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log("PASS", name, extra); }
  else { fail++; console.log("FAIL", name, extra); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** In-page helper source: measure the client rect of a Range over [a,b) of the
 * first text node of the given span element. Injected as a function string. */
const RANGE_RECT = `(span, a, b) => {
  const tn = span.firstChild;
  if (!tn || tn.nodeType !== Node.TEXT_NODE) return null;
  const range = document.createRange();
  range.setStart(tn, a);
  range.setEnd(tn, b);
  const r = range.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
}`;

/** Snapshot the set of data-owner ids currently on the page. */
async function ownersOf(p) {
  return p.evaluate(() =>
    [...document.querySelectorAll(".pdf-overlay[data-owner]")].map((d) => d.getAttribute("data-owner")),
  );
}

/**
 * Select the phrase described by finder (runs in page, returns {selKey, a, b})
 * with a real mouse drag, click the amber palette swatch, and compare the new
 * overlay's union rect against the freshly re-measured expected Range rect.
 * Returns { hlId, dl, dr, overlap } or null on failure.
 */
async function highlightAndMeasure(p, locateJs, label) {
  const before = await ownersOf(p);

  // locate target span + offsets, scroll it into view, return drag geometry
  const target = await p.evaluate(`(() => {
    const locate = ${locateJs};
    const rangeRect = ${RANGE_RECT};
    const t = locate();
    if (!t) return null;
    t.span.scrollIntoView({ block: "center" });
    return { ok: true };
  })()`);
  if (!target) { check(`${label}: target phrase found`, false); return null; }
  await sleep(600); // settle after scroll (overlays re-anchor, palette geometry)

  const geo = await p.evaluate(`(() => {
    const locate = ${locateJs};
    const rangeRect = ${RANGE_RECT};
    const t = locate();
    if (!t) return null;
    const r = rangeRect(t.span, t.a, t.b);
    if (!r) return null;
    return { r, text: t.span.textContent.slice(t.a, t.b) };
  })()`);
  if (!geo) { check(`${label}: range measurable`, false); return null; }
  console.log(`  [${label}] selecting "${geo.text}" expected rect L=${geo.r.left.toFixed(1)} R=${geo.r.right.toFixed(1)}`);

  const y = (geo.r.top + geo.r.bottom) / 2;
  await p.mouse.move(geo.r.left + 2, y);
  await p.mouse.down();
  await p.mouse.move(geo.r.left + (geo.r.right - geo.r.left) / 2, y, { steps: 6 });
  await p.mouse.move(geo.r.right - 2, y, { steps: 10 });
  await p.mouse.up();
  await sleep(700);

  const clicked = await p.evaluate(() => {
    const btn = document.querySelector('div[role=toolbar] button[aria-label*="amber"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicked) { check(`${label}: amber palette button`, false, "palette not found after drag"); return null; }
  await sleep(2000);

  const after = await ownersOf(p);
  const fresh = [...new Set(after.filter((id) => !before.includes(id)))];
  if (fresh.length !== 1) {
    check(`${label}: exactly one new overlay owner`, false, `new owners: ${JSON.stringify(fresh)}`);
    return null;
  }
  const hlId = fresh[0];

  // measure overlay union AND re-measure expected rect in the SAME evaluate
  // (immune to any scroll that happened when the card opened)
  const m = await p.evaluate(`((ownerId) => {
    const locate = ${locateJs};
    const rangeRect = ${RANGE_RECT};
    const t = locate();
    if (!t) return null;
    const exp = rangeRect(t.span, t.a, t.b);
    const divs = [...document.querySelectorAll('.pdf-overlay[data-owner="' + ownerId + '"]')];
    if (!exp || divs.length === 0) return null;
    let L = Infinity, R = -Infinity, T = Infinity, B = -Infinity;
    for (const d of divs) {
      const r = d.getBoundingClientRect();
      L = Math.min(L, r.left); R = Math.max(R, r.right);
      T = Math.min(T, r.top); B = Math.max(B, r.bottom);
    }
    return { exp, ov: { left: L, right: R, top: T, bottom: B }, n: divs.length };
  })(${JSON.stringify(fresh[0])})`);
  if (!m) { check(`${label}: overlay measurable`, false); return { hlId, dl: NaN, dr: NaN, overlap: false }; }

  const dl = m.ov.left - m.exp.left;
  const dr = m.ov.right - m.exp.right;
  const overlap = m.ov.top < m.exp.bottom && m.ov.bottom > m.exp.top;
  check(
    `${label}: overlay within 2px of glyph rect`,
    Math.abs(dl) <= 2 && Math.abs(dr) <= 2 && overlap,
    `dLeft=${dl.toFixed(2)}px dRight=${dr.toFixed(2)}px vOverlap=${overlap} (${m.n} overlay div(s))`,
  );
  return { hlId, dl, dr, overlap };
}

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage();
  await p.setViewport({ width: 1920, height: 950 });
  await p.goto(`http://localhost:3000/read/${DOC}`, { waitUntil: "networkidle2", timeout: 90000 });
  await p.waitForSelector(".rd-pdf-page canvas", { timeout: 30000 });
  await sleep(3000);
  const created = [];

  // ---- 1. PRECISION ON TITLE ("tabanid flies", large font) ------------------
  const locateTitle = `(() => {
    const spans = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')];
    const span = spans.find((s) => (s.textContent || "").includes("tabanid"));
    if (!span) return null;
    const text = span.textContent || "";
    let phrase = "tabanid flies";
    let a = text.indexOf(phrase);
    if (a === -1) { phrase = "tabanid"; a = text.indexOf(phrase); }
    if (a === -1) return null;
    return { span, a, b: a + phrase.length };
  })`;
  const title = await highlightAndMeasure(p, locateTitle, "P1 title");
  if (title) created.push(title.hlId);

  // ---- 3. BUTTONS ONLY ON EMPTY THREAD (on the title card) ------------------
  const cardState = await p.evaluate(() => {
    const card = document.querySelector("[data-card] textarea")?.closest("[data-card]");
    if (!card) return null;
    const labels = [...card.querySelectorAll("button")].map((x) => (x.textContent || "").trim());
    return { id: card.getAttribute("data-card"), labels };
  });
  check("P3: card open for title highlight", !!cardState && !!title && cardState.id === title.hlId,
    cardState ? `card=${cardState.id}` : "no expanded card");
  check(
    "P3: empty thread shows Explain + Explain with example",
    !!cardState && cardState.labels.includes("Explain") && cardState.labels.includes("Explain with example"),
    cardState ? `buttons: ${JSON.stringify(cardState.labels)}` : "",
  );

  // ---- 4. full-viewport screenshot with title highlight + open card ---------
  await p.screenshot({ path: "v-precision-title.png" });
  console.log("  screenshot: v-precision-title.png (full viewport)");

  // type a note and save it — starter buttons must disappear
  const noted = await p.evaluate(() => {
    const ta = document.querySelector("[data-card] textarea");
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, "precision battery note — no AI");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    const card = ta.closest("[data-card]");
    const note = [...card.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "Note");
    if (!note) return false;
    note.click();
    return true;
  });
  check("P3: note typed and Note clicked", noted);
  await sleep(1500);
  const afterNote = await p.evaluate(() => {
    const card = document.querySelector("[data-card] textarea")?.closest("[data-card]") ||
      document.querySelector("[data-card]");
    if (!card) return null;
    return {
      hasExplain: [...card.querySelectorAll("button")].some((x) => (x.textContent || "").trim() === "Explain"),
      hasTextarea: !!card.querySelector("textarea"),
    };
  });
  check("P3: starter buttons gone after note", !!afterNote && !afterNote.hasExplain,
    afterNote ? "" : "card vanished");
  check("P3: textarea remains after note", !!afterNote && afterNote.hasTextarea);

  // ---- 2. PRECISION ON BODY TEXT --------------------------------------------
  const locateBody = `(() => {
    const spans = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')];
    const cands = spans.filter((s) => {
      const t = s.textContent || "";
      if (t.length <= 40 || t.includes("tabanid")) return false;
      const fs = parseFloat(getComputedStyle(s).fontSize);
      return fs > 6 && fs < 20; // normal body text, not title
    });
    for (const span of cands) {
      const text = span.textContent || "";
      // word start offsets
      const words = [];
      const re = /\\S+/g;
      let mm;
      while ((mm = re.exec(text))) words.push({ a: mm.index, b: mm.index + mm[0].length });
      if (words.length < 6) continue;
      // phrase of 3 words starting near 20% of the string, ending before 60%
      const startW = words.find((w) => w.a >= text.length * 0.2);
      if (!startW) continue;
      const i = words.indexOf(startW);
      let j = i;
      while (j + 1 < words.length && j - i < 3 && words[j + 1].b <= text.length * 0.6) j++;
      if (j - i < 1) continue; // want 2-4 words
      // trim punctuation at the edges: a trailing comma is a ~4px glyph, and a
      // drag ending inside it makes caret snapping ambiguous (test flake, not
      // overlay drift)
      let a = startW.a, bb = words[j].b;
      while (bb > a && !/[A-Za-z0-9]/.test(text[bb - 1])) bb--;
      while (a < bb && !/[A-Za-z0-9]/.test(text[a])) a++;
      if (bb - a < 8) continue;
      return { span, a, b: bb };
    }
    return null;
  })`;
  const body = await highlightAndMeasure(p, locateBody, "P2 body");
  if (body) created.push(body.hlId);

  // ---- 5. CLEANUP ------------------------------------------------------------
  for (const id of created) {
    const ok = await p.evaluate(async (x) =>
      (await fetch(`/api/highlights/${x}`, { method: "DELETE" })).ok, id);
    check(`P5: DELETE highlight ${id.slice(0, 8)}`, ok);
  }
  await p.reload({ waitUntil: "networkidle2", timeout: 90000 });
  await p.waitForSelector(".rd-pdf-page canvas", { timeout: 30000 });
  await sleep(3000);
  const leftovers = await p.evaluate((ids) =>
    ids.filter((id) => document.querySelector(`.pdf-overlay[data-owner="${id}"]`)), created);
  check("P5: overlays gone after delete", leftovers.length === 0,
    leftovers.length ? `still present: ${leftovers.join(", ")}` : `${created.length} checked`);

  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
