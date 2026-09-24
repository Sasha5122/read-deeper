/**
 * SEARCH RECALL battery — "prove the AI search leaves no gaps".
 *
 * Fixture: recall.pdf (scripts/audit-fixtures.js buildRecallPdf) — 20 pages,
 * 10 sentinel facts about the XR-7's MECHANICAL specs on known pages
 * (2,4,...,20 — map exported as RECALL_SENTINELS), filler pages on other
 * themes (electrical/software) so retrieval can't win by accident.
 *
 * Phase 1 (always) — FULL-DOC regime: upload recall.pdf, wait for AI prep,
 * one search ("Find everything regarding the mechanical specifications of
 * the XR-7 device."), then:
 *   R0: recall.pdf paginated to exactly 20 pages (sentinel map validity)
 *   S0: [data-testid="search-thinking"] seen after Find (SOFT — WARN only)
 *   R1: >=9/10 sentinel pages cited ((p. N) in the answer + jump buttons)
 *   R2: >=8 clickable finding rows ([data-testid="aisearch-finding"])
 *   R3: clicking the highest-page finding scrolls the document there
 *   R4: search-current flash overlay (.hl-search-current[-marker]) within 3s
 *
 * Phase 2 (OPTIONAL, env RD_RECALL_OVERSIZED=1) — OVERSIZED/RAG regime:
 * the battery cannot change server env, so the ORCHESTRATOR must have
 * started the dev server with DOC_FULL_CONTEXT_MAX_TOKENS=2000 (every doc
 * lands on the RAG branch). Same upload+search+checks, threshold >=8/10.
 *
 * AI budget: exactly 1 search question per phase.
 * Conventions (CLAUDE.md): waitForURL must demand a DIFFERENT url; file
 * inputs are hidden -> state:"attached"; real p.mouse.click for row clicks
 * (synthetic dispatchEvent clicks don't collapse DOM selection).
 * Prereq: node scripts/audit-fixtures.js (Gotenberg up) to build recall.pdf.
 */
const playwright = require("playwright");
const path = require("path");
const fs = require("fs");
const { RECALL_SENTINELS } = require("./audit-fixtures.js");

const BASE = process.env.RD_BASE ?? "http://localhost:3000";
const FIX = path.join(process.env.TEMP, "rd-audit-fixtures");
const RECALL_PDF = path.join(FIX, "recall.pdf");
const SENTINEL_PAGES = Object.keys(RECALL_SENTINELS).map(Number).sort((a, b) => a - b);
const QUESTION =
  "Find everything regarding the mechanical specifications of the XR-7 device.";
const OVERSIZED = process.env.RD_RECALL_OVERSIZED === "1";

let pass = 0, fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log("PASS", name, extra); }
  else { fail++; console.log("FAIL", name, extra); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ helpers */

/** Delete leftover recall docs from crashed earlier runs (their sessions
 * pollute Recents and the "newest ready doc" entry redirect). Must run on
 * an authenticated page (dev autologin). */
async function purgeRecallDocs(p) {
  const purged = await p.evaluate(async () => {
    try {
      const rec = await (await fetch("/api/recents")).json();
      let n = 0;
      for (const s of rec.sessions ?? []) {
        if (/^recall/i.test(s.title ?? "")) {
          await fetch(`/api/documents/${s.documentId}`, { method: "DELETE" });
          n++;
        }
      }
      return n;
    } catch { return -1; }
  });
  console.log(`preflight: purged ${purged} leftover recall doc(s)`);
}

/** Find the (hidden) upload file input: reader header Recents -> New session,
 * or the empty-account landing's UploadPanel input. */
async function openUploadInput(p) {
  const hasRecents = await p.evaluate(() =>
    [...document.querySelectorAll("header button")].some((x) => x.textContent.includes("Recents")));
  if (!hasRecents) {
    // upload-first landing — its file input is hidden too
    return p.waitForSelector("input[type=file]", { timeout: 10000, state: "attached" });
  }
  await p.keyboard.press("Escape");
  await sleep(300);
  await p.evaluate(() => {
    [...document.querySelectorAll("header button")].find((x) => x.textContent.includes("Recents")).click();
  });
  await p.waitForFunction(
    () => [...document.querySelectorAll("button")].some((x) => x.textContent.includes("New session")),
    { timeout: 8000 });
  await p.evaluate(() => {
    [...document.querySelectorAll("button")].find((x) => x.textContent.includes("New session")).click();
  });
  return p.waitForSelector("div[role=dialog] input[type=file]", { timeout: 8000, state: "attached" });
}

/** Wait for the AI index (embeddings/markdown) — the aiprep badge must be
 * gone and STAY gone (3 consecutive absent samples), up to 120s. The badge
 * may legitimately never appear when prep finished before mount. */
async function waitAiPrep(p, timeoutMs = 120000) {
  const t0 = Date.now();
  await sleep(4000); // grace: give the status fetch time to surface the badge
  let absent = 0;
  while (Date.now() - t0 < timeoutMs) {
    const badge = await p.evaluate(() =>
      !!document.querySelector('[data-testid="aiprep-badge"]'));
    if (!badge) { absent++; if (absent >= 3) return Date.now() - t0; }
    else absent = 0;
    await sleep(2000);
  }
  return -1; // timed out — proceed anyway, R1 will tell the truth
}

/** Read {scrollTop, page} of the document scrollport (the zoomport or its
 * nearest scrollable ancestor); optionally park it at the top first. */
const readScrollState = (p, parkTop = false) =>
  p.evaluate((park) => {
    let el = document.querySelector(".rd-zoomport");
    while (el && !(el.scrollHeight > el.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(el).overflowY)))
      el = el.parentElement;
    if (el && park) el.scrollTop = 0;
    return {
      open: !!document.querySelector('[data-testid="aisearch-dialog"]'),
      scrollTop: el ? el.scrollTop : 0,
      page: document.querySelector('input[aria-label="Go to page"]')?.value ?? "",
    };
  }, parkTop);

/** Wait until the search stream is over: no "Searching…" button, answer text
 * stable across 3 samples. Returns the final answer container text. */
async function waitSearchEnd(p, timeoutMs = 240000) {
  const t0 = Date.now();
  let last = -1, stable = 0;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1200);
    const st = await p.evaluate(() => {
      const dlg = document.querySelector('[data-testid="aisearch-dialog"]');
      if (!dlg) return { busy: true, len: 0 };
      const busy = [...dlg.querySelectorAll("button")].some((b) => /Searching…/.test(b.textContent || ""));
      return { busy, len: (dlg.textContent || "").length };
    });
    if (!st.busy && st.len === last && st.len > 0) { stable++; if (stable >= 3) break; }
    else stable = 0;
    last = st.len;
  }
  return p.evaluate(() =>
    document.querySelector('[data-testid="aisearch-dialog"]')?.textContent ?? "");
}

/** Union of pages cited in the dialog: (p. N)/(pp. N-M)/p. N/page N in the
 * text + the jump buttons ("p. N"). Range expansion capped at 10 like the
 * app's own parseCitedPages. */
function parseCited(dialogText, jumpPages) {
  const found = new Set(jumpPages);
  const LIST = String.raw`\d+(?:\s*[-–—]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-–—]\s*\d+)?)*`;
  const patterns = [
    new RegExp(String.raw`\(\s*(?:pp?|pag)\.?\s*(${LIST})\s*\)`, "gi"),
    new RegExp(String.raw`\bpp?\.\s*(${LIST})`, "gi"),
    new RegExp(String.raw`\bpages?\s+(${LIST})`, "gi"),
  ];
  for (const re of patterns) {
    for (const m of dialogText.matchAll(re)) {
      for (const item of m[1].split(",")) {
        const nums = item.match(/\d+/g);
        if (!nums) continue;
        const from = Number(nums[0]);
        if (!Number.isInteger(from) || from < 1 || from > 500) continue;
        const to = nums.length > 1 ? Number(nums[1]) : from;
        const end = to >= from ? Math.min(to, from + 9) : from;
        for (let pg = from; pg <= end; pg++) found.add(pg);
      }
    }
  }
  return found;
}

const apiDeleteDoc = (p, id) =>
  p.evaluate(async (did) => (await fetch(`/api/documents/${did}`, { method: "DELETE" })).ok, id);

/* ------------------------------------------------------------ one phase */

/** Upload recall.pdf, run ONE search, assert recall. Returns {found, docId}. */
async function runRecallPhase(p, label, threshold) {
  const L = (n) => `[${label}] ${n}`;

  /* ---- upload via the New-session dialog (different-url wait) ---- */
  const fi = await openUploadInput(p);
  const urlBefore = p.url();
  await fi.setInputFiles(RECALL_PDF);
  let navved = false;
  try {
    await p.waitForURL((u) => u.pathname.startsWith("/read/") && u.href !== urlBefore, { timeout: 180000 });
    navved = true;
  } catch { /* stays false */ }
  check(L("upload navigates to the new document"), navved, p.url());
  if (!navved) return { found: 0, docId: null };
  const docId = p.url().split("/read/")[1].split(/[?#]/)[0];
  await p.waitForSelector(".rd-pdf-page canvas", { timeout: 60000 }).catch(() => {});
  await sleep(2500);

  /* ---- R0: pagination sanity — the sentinel map is per-page ---- */
  const pageCount = await p.evaluate(() => {
    for (const span of document.querySelectorAll("span")) {
      const m = /^of\s+(\d+)$/.exec((span.textContent || "").trim());
      if (m) return Number(m[1]);
    }
    return null;
  });
  check(L("R0: recall.pdf paginated to exactly 20 pages"), pageCount === 20, `of ${pageCount}`);

  /* ---- AI prep (embeddings + markdown) before searching ---- */
  const prepMs = await waitAiPrep(p);
  console.log(prepMs >= 0
    ? `${label}: AI prep ready after ${(prepMs / 1000).toFixed(1)}s`
    : `${label}: WARN aiprep badge still visible after 120s — searching anyway`);

  /* ---- ask (AI call: 1 per phase) ---- */
  await p.evaluate(() => {
    [...document.querySelectorAll("header button")].find((x) => x.textContent.includes("AI search")).click();
  });
  await p.waitForSelector('[data-testid="aisearch-dialog"]', { timeout: 8000 });
  await sleep(400);
  const dlgInput = await p.waitForSelector('[data-testid="aisearch-dialog"] textarea', { timeout: 8000 });
  await dlgInput.fill(QUESTION);
  await p.press('[data-testid="aisearch-dialog"] textarea', "Enter");

  /* ---- S0 (SOFT): animated thinking indicator right after Find ---- */
  let thinkingSeen = false;
  const tThink = Date.now();
  while (Date.now() - tThink < 3000) {
    thinkingSeen = await p.evaluate(() =>
      !!document.querySelector('[data-testid="search-thinking"]'));
    if (thinkingSeen) break;
    await sleep(50);
  }
  if (thinkingSeen) check(L("S0: search-thinking indicator shown (soft)"), true);
  else console.log(`${label}: WARN search-thinking indicator never seen within 3s (may vanish fast on cached prefixes) — not counted as a failure`);

  const dialogText = await waitSearchEnd(p);

  /* ---- R1: every sentinel page cited ---- */
  const jumpPages = await p.evaluate(() =>
    [...document.querySelectorAll('[data-testid="aisearch-jump"]')]
      .map((b) => Number((b.textContent || "").match(/\d+/)?.[0]))
      .filter((n) => Number.isInteger(n)));
  const cited = parseCited(dialogText, jumpPages);
  const missing = SENTINEL_PAGES.filter((pg) => !cited.has(pg));
  const found = SENTINEL_PAGES.length - missing.length;
  check(L(`R1: >=${threshold}/10 sentinel pages cited`), found >= threshold,
    `${found}/10 found; cited={${[...cited].sort((a, b) => a - b).join(",")}}` +
    (missing.length ? `; MISSING sentinel pages: ${missing.join(", ")}` : ""));

  /* ---- R2: clickable finding rows ---- */
  const findingCount = await p.evaluate(() =>
    document.querySelectorAll('[data-testid="aisearch-finding"]').length);
  check(L("R2: >=8 clickable finding rows"), findingCount >= 8, `${findingCount} rows`);

  /* ---- R3+R4: click the HIGHEST-page finding -> document scrolls + flash ---- */
  // Which row cites the highest page? Prefer explicit p./page citations in the
  // row text; fall back to any plausible page number (<= pageCount).
  const target = await p.evaluate((maxPage) => {
    const rows = [...document.querySelectorAll('[data-testid="aisearch-finding"]')];
    const pageOf = (t) => {
      const cites = [...t.matchAll(/\b(?:pp?\.|pages?)\s*(\d{1,3})/gi)].map((m) => Number(m[1]));
      const pool = cites.length
        ? cites
        : (t.match(/\d{1,3}/g) || []).map(Number).filter((n) => n >= 1 && n <= (maxPage || 30));
      return pool.length ? Math.max(...pool) : 0;
    };
    let best = null;
    rows.forEach((r, i) => {
      const pg = pageOf(r.textContent || "");
      if (!best || pg > best.page) best = { idx: i, page: pg, kind: "finding" };
    });
    if (!best || !best.page) {
      // fallback: highest enabled jump button (findings not rendered yet)
      const jumps = [...document.querySelectorAll('[data-testid="aisearch-jump"]:not([disabled])')];
      jumps.forEach((b, i) => {
        const pg = Number((b.textContent || "").match(/\d+/)?.[0] ?? 0);
        if (!best || pg > best.page) best = { idx: i, page: pg, kind: "jump" };
      });
    }
    if (!best || !best.page) return null;
    const el = best.kind === "finding"
      ? rows[best.idx]
      : [...document.querySelectorAll('[data-testid="aisearch-jump"]:not([disabled])')][best.idx];
    el.scrollIntoView({ block: "center" });
    return best;
  }, pageCount);
  check(L("R3: a clickable target citing a late page exists"), !!target && target.page >= 10,
    target ? `${target.kind} -> p. ${target.page}` : "none");
  if (target) {
    if (target.kind === "jump") console.log(`${label}: NOTE R3 falling back to a jump button — no finding rows carried a page`);
    await sleep(500);
    // park the document at the very TOP so a jump to a late page must move it
    const before = await readScrollState(p, true);
    await sleep(600);
    const rect = await p.evaluate((t) => {
      const el = t.kind === "finding"
        ? [...document.querySelectorAll('[data-testid="aisearch-finding"]')][t.idx]
        : [...document.querySelectorAll('[data-testid="aisearch-jump"]:not([disabled])')][t.idx];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 20) };
    }, target);
    if (rect) {
      // real mouse click (CLAUDE.md gotcha: synthetic dispatchEvent clicks
      // don't collapse DOM selection like a real mousedown)
      await p.mouse.click(rect.x, rect.y);
      // R4: flash overlay near the target within 3s of the click
      let flashSeen = false;
      const tFlash = Date.now();
      while (Date.now() - tFlash < 3000) {
        flashSeen = await p.evaluate(() =>
          !!document.querySelector(".hl-search-current, .hl-search-current-marker"));
        if (flashSeen) break;
        await sleep(100);
      }
      const after = await readScrollState(p);
      check(L("R3: document scrolled to the late finding"),
        after.scrollTop - before.scrollTop > 50 || (after.page && after.page !== before.page),
        `scroll ${before.scrollTop} -> ${after.scrollTop}, page ${before.page || "?"} -> ${after.page || "?"} (target p. ${target.page})`);
      check(L("R3: dialog still open after the jump (non-modal)"), after.open);
      check(L("R4: search-current flash overlay within 3s of the click"), flashSeen);
    } else {
      check(L("R3: target still on screen for the click"), false);
    }
  }

  /* ---- cleanup this phase's doc ---- */
  await p.keyboard.press("Escape");
  await sleep(400);
  const deleted = await apiDeleteDoc(p, docId);
  console.log(`${label}: cleanup doc ${docId} deleted=${deleted}`);
  return { found, docId };
}

/* ------------------------------------------------------------ main */

(async () => {
  if (!fs.existsSync(RECALL_PDF)) {
    console.log(`FATAL: ${RECALL_PDF} missing — run \`node scripts/audit-fixtures.js\` first (Gotenberg on :3010)`);
    process.exit(1);
  }
  const b = await playwright.chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1920, height: 950 } })).newPage();
  let fullFound = 0;
  let overFound = null;

  try {
    await p.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 90000 });
    await sleep(1500);
    await purgeRecallDocs(p);

    /* ---- Phase 1: FULL-DOC regime ---- */
    ({ found: fullFound } = await runRecallPhase(p, "full-doc", 9));

    /* ---- Phase 2: OVERSIZED regime (optional, orchestrator-gated) ---- */
    if (OVERSIZED) {
      console.log("\nRD_RECALL_OVERSIZED=1 — server must be running with DOC_FULL_CONTEXT_MAX_TOKENS=2000 (RAG branch forced)");
      await p.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 90000 });
      await sleep(1500);
      ({ found: overFound } = await runRecallPhase(p, "oversized", 8));
    } else {
      console.log("\nPhase 2 (oversized/RAG) SKIPPED — set RD_RECALL_OVERSIZED=1 and start the dev server with DOC_FULL_CONTEXT_MAX_TOKENS=2000 to run it");
    }

    /* ---- safety net: any recall doc that survived a failed check ---- */
    await purgeRecallDocs(p);
  } catch (err) {
    fail++;
    console.log("FAIL suite crashed:", err.message);
    // last-ditch cleanup so crashed runs don't poison the next one
    await purgeRecallDocs(p).catch(() => {});
  }

  console.log(`\nRECALL full-doc: ${fullFound}/10, oversized: ${overFound == null ? "skipped" : `${overFound}/10`}`);
  console.log(`${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
