/**
 * Premium suite for the 2026-09-23 batch (local, DEV_AUTOLOGIN, Playwright):
 * cross-page highlights · capture clamping (bottom / released-outside) ·
 * link drag-selection · PDF load-error resilience · delete-while-streaming +
 * undo merge · blocked-send hint · scroll freedom during streaming ·
 * interrupted-answer marker · markdown tables · docked non-modal AI search ·
 * continuous upload bar · background upload toast · cancel · scanned banner ·
 * failed Recents rows · Recents error/retry · corrupt-PDF message ·
 * ctrl+wheel zoom · Esc hierarchy · unified error banner.
 *
 * AI budget: exactly 5 short questions (C1, C2/C3 shared, C4, C5, S2).
 * Conventions (CLAUDE.md): waitForURL must demand a DIFFERENT url when we are
 * already on /read/; file inputs are hidden -> state:"attached".
 */
const playwright = require("playwright");
const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const BASE = process.env.RD_BASE ?? "http://localhost:3000";
const ZEBRA = "8d030271-2e23-4a9b-bfb1-5e8802b70839"; // 13-page zebra article with DOI links
const FIX = path.join(process.env.TEMP, "rd-audit-fixtures");
// local supabase demo service key (public demo value, local stack only)
const LOCAL_SERVICE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

let pass = 0, fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log("PASS", name, extra); }
  else { fail++; console.log("FAIL", name, extra); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ helpers */

/** Crashed earlier runs leave orphan highlights on the SAME deterministic
 * spans — clicks then open the leftover's card instead of ours. Purge the
 * zebra doc's highlights/regions before starting (local admin key). */
async function purgeZebra() {
  const admin = createClient("http://127.0.0.1:54321", LOCAL_SERVICE, { auth: { persistSession: false } });
  const { data: hls } = await admin.from("highlights").select("id").eq("document_id", ZEBRA);
  const { data: rgs } = await admin.from("regions").select("id").eq("document_id", ZEBRA);
  for (const kind of [["highlight_id", hls], ["region_id", rgs]]) {
    const [col, rows] = kind;
    for (const r of rows ?? []) {
      const { data: ths } = await admin.from("threads").select("id").eq(col, r.id);
      for (const t of ths ?? []) await admin.from("messages").delete().eq("thread_id", t.id);
      await admin.from("threads").delete().eq(col, r.id);
    }
  }
  await admin.from("highlights").delete().eq("document_id", ZEBRA);
  await admin.from("regions").delete().eq("document_id", ZEBRA);
  console.log(`preflight: purged ${(hls ?? []).length} highlights, ${(rgs ?? []).length} regions on zebra`);
}

async function openDoc(p, id = ZEBRA) {
  await p.goto(`${BASE}/read/${id}`, { waitUntil: "networkidle", timeout: 90000 });
  await p.waitForSelector(".rd-pdf-page canvas", { timeout: 45000 });
  await sleep(3000);
}

/** Drag-select the nth long span on page 1 and pick a colour; returns highlight id. */
async function makeHighlight(p, spanIdx, color = "blue") {
  // page 1's text layer may be virtualized out after far scrolling — bring it
  // back first and WAIT for its spans (a missing span crashed a whole run).
  await p.evaluate(() => document.querySelector('[data-page="1"]')?.scrollIntoView({ block: "start" }));
  await p.waitForFunction(() =>
    [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')]
      .filter((x) => (x.textContent || "").trim().length > 40).length > 0,
    { timeout: 15000 });
  await p.evaluate((idx) => {
    const spans = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')]
      .filter((x) => (x.textContent || "").trim().length > 40);
    spans[idx % spans.length]?.scrollIntoView({ block: "center" });
  }, spanIdx);
  await sleep(700);
  const geo = await p.evaluate((idx) => {
    const spans = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')]
      .filter((x) => (x.textContent || "").trim().length > 40);
    const s = spans[idx % spans.length];
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return { x1: r.left + 2, y1: r.top + r.height / 2, x2: r.left + r.width * 0.55, y2: r.top + r.height / 2 };
  }, spanIdx);
  if (!geo) return null;
  await p.mouse.move(geo.x1, geo.y1);
  await p.mouse.down();
  await p.mouse.move(geo.x2, geo.y2, { steps: 10 });
  await p.mouse.up();
  await sleep(800);
  await p.evaluate((c) =>
    document.querySelector(`div[role=toolbar] button[aria-label*="${c}"]`)?.click(), color);
  await sleep(1800);
  return p.evaluate(() =>
    document.querySelector("[data-card] textarea")?.closest("[data-card]")?.getAttribute("data-card"));
}

/** Click a highlight/region overlay to (re)open its card. */
async function openOverlay(p, id) {
  await p.evaluate((hid) =>
    document.querySelector(`.pdf-overlay[data-owner="${hid}"]`)?.scrollIntoView({ block: "center" }), id);
  await sleep(700);
  await p.evaluate((hid) => {
    const d = document.querySelector(`.pdf-overlay[data-owner="${hid}"]`);
    if (!d) return;
    const r = d.getBoundingClientRect();
    document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
  }, id);
  await sleep(900);
}

const cardText = (p, id) => p.evaluate((hid) => {
  const c = document.querySelector(`[data-card="${hid}"]`);
  return c ? (c.textContent || "").length : 0;
}, id);

/** Wait until the stream on a card has visibly started producing text. */
async function waitFirstToken(p, id, baseLen, timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await cardText(p, id)) > baseLen + 20) return true;
    await sleep(500);
  }
  return false;
}

/** Wait until generation is over (no thinking, no stop button, text stable). */
async function waitStreamEnd(p, id, timeoutMs = 200000) {
  const t0 = Date.now();
  let last = -1, stable = 0;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1200);
    const st = await p.evaluate((hid) => ({
      busy: !!document.querySelector('[data-testid="thinking-indicator"]') ||
        !!document.querySelector('button[aria-label="Stop generating"]'),
      len: (document.querySelector(`[data-card="${hid}"]`)?.textContent || "").length,
    }), id);
    if (!st.busy && st.len === last) { stable++; if (stable >= 3) return st.len; }
    else stable = 0;
    last = st.len;
  }
  return last;
}

/** Open Recents -> New session; returns the (hidden) file input handle. */
async function openNewSession(p) {
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

const apiDeleteHighlight = (p, id) =>
  p.evaluate(async (hid) => (await fetch(`/api/highlights/${hid}`, { method: "DELETE" })).ok, id);
const apiDeleteDoc = (p, id) =>
  p.evaluate(async (did) => (await fetch(`/api/documents/${did}`, { method: "DELETE" })).ok, id);

(async () => {
  const b = await playwright.chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1920, height: 950 } })).newPage();
  const hlIds = [];

  try {
    await purgeZebra();
    await openDoc(p);

    /* ================= PDF view ================= */

    /* ---- P1: cross-page selection spans page 1 AND page 2 ---- */
    await p.evaluate(() => document.querySelector('[data-page="2"]')?.scrollIntoView({ block: "start" }));
    await sleep(700);
    await p.evaluate(() => {
      // pull back up a bit so the tail of page 1 is visible above page 2
      let el = document.querySelector(".rd-zoomport");
      while (el && !(el.scrollHeight > el.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(el).overflowY)))
        el = el.parentElement;
      if (el) el.scrollTop -= 260;
    });
    await sleep(700);
    const xgeo = await p.evaluate(() => {
      const p2rect = document.querySelector('[data-page="2"]').getBoundingClientRect();
      const visible = (r) => r.top > 60 && r.bottom < 940 && r.width > 5;
      const p1spans = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')]
        .filter((s) => (s.textContent || "").trim().length > 10 && visible(s.getBoundingClientRect()));
      const p2spans = [...document.querySelectorAll('[data-page="2"] .pdf-textlayer span')]
        .filter((s) => (s.textContent || "").trim().length > 10 && visible(s.getBoundingClientRect()));
      if (!p1spans.length || !p2spans.length) return null;
      const last1 = p1spans.reduce((a, x) =>
        x.getBoundingClientRect().top > a.getBoundingClientRect().top ? x : a);
      const first2 = p2spans.reduce((a, x) =>
        x.getBoundingClientRect().top < a.getBoundingClientRect().top ? x : a);
      const r1 = last1.getBoundingClientRect();
      const r2 = first2.getBoundingClientRect();
      return {
        x1: r1.left + 3, y1: r1.top + r1.height / 2,
        x2: r2.left + Math.min(r2.width * 0.7, 200), y2: r2.top + r2.height / 2,
        p2top: p2rect.top,
      };
    });
    check("P1: page-1 tail + page-2 head both visible for the drag", !!xgeo);
    let xpageId = null;
    if (xgeo) {
      await p.mouse.move(xgeo.x1, xgeo.y1);
      await p.mouse.down();
      await p.mouse.move(xgeo.x2, xgeo.y2, { steps: 16 });
      await p.mouse.up();
      await sleep(900);
      await p.evaluate(() => document.querySelector('div[role=toolbar] button[aria-label*="green"]')?.click());
      await sleep(2000);
      xpageId = await p.evaluate(() =>
        document.querySelector("[data-card] textarea")?.closest("[data-card]")?.getAttribute("data-card"));
      const both = await p.evaluate((id) => ({
        p1: !!document.querySelector(`[data-page="1"] .pdf-overlay[data-owner="${id}"]`),
        p2: !!document.querySelector(`[data-page="2"] .pdf-overlay[data-owner="${id}"]`),
      }), xpageId);
      check("P1: cross-page highlight created", !!xpageId, xpageId ?? "");
      check("P1: overlay rendered inside BOTH page 1 and page 2", both.p1 && both.p2, JSON.stringify(both));
      if (xpageId) { await apiDeleteHighlight(p, xpageId); await sleep(600); }
      await p.keyboard.press("Escape");
      await sleep(400);
    }

    /* ---- P2: capture palette clamped near the page bottom ---- */
    await p.evaluate(() => {
      const r = document.querySelector('[data-page="2"]').getBoundingClientRect();
      let el = document.querySelector(".rd-zoomport");
      while (el && !(el.scrollHeight > el.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(el).overflowY)))
        el = el.parentElement;
      if (el) el.scrollTop += r.bottom - 900; // page-2 bottom at ~y=900, inside the viewport
    });
    await sleep(700);
    await p.evaluate(() => {
      [...document.querySelectorAll("header button")].find((x) => /Capture|Draw a box/.test(x.textContent)).click();
    });
    await sleep(900);
    const page2 = await p.evaluate(() => {
      const r = document.querySelector('[data-page="2"]').getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    await p.mouse.move(page2.left + 80, page2.bottom - 90);
    await p.mouse.down();
    await p.mouse.move(page2.left + 320, page2.bottom - 15, { steps: 8 });
    await p.mouse.up();
    await sleep(700);
    const clamped = await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button[aria-label^="Capture in"]')];
      if (!btns.length) return null;
      const page = document.querySelector('[data-page="2"]').getBoundingClientRect();
      const inside = btns.every((btn) => {
        const r = btn.getBoundingClientRect();
        return r.left >= page.left - 2 && r.right <= page.right + 2 &&
          r.top >= page.top - 2 && r.bottom <= page.bottom + 2;
      });
      return { count: btns.length, inside };
    });
    check("P2: colour palette appears after bottom-edge framing", !!clamped, clamped ? `${clamped.count} swatches` : "no palette");
    check("P2: palette fully inside the page (clamped, not cut off)", !!clamped && clamped.inside);
    await p.keyboard.press("Escape");
    await sleep(500);

    /* ---- P3: capture drag released OUTSIDE the page (right margin) ---- */
    await p.evaluate(() => {
      [...document.querySelectorAll("header button")].find((x) => /Capture|Draw a box/.test(x.textContent)).click();
    });
    await sleep(900);
    const page2b = await p.evaluate(() => {
      const r = document.querySelector('[data-page="2"]').getBoundingClientRect();
      return { left: r.left, right: r.right, top: Math.max(r.top, 80) };
    });
    await p.mouse.move(page2b.left + 100, page2b.top + 180);
    await p.mouse.down();
    await p.mouse.move(page2b.right + 120, page2b.top + 320, { steps: 10 }); // released in the margin
    await p.mouse.up();
    await sleep(700);
    const clamped2 = await p.evaluate(() =>
      document.querySelectorAll('button[aria-label^="Capture in"]').length);
    check("P3: palette appears when the drag ends outside the page (rect clamped)", clamped2 > 0, `${clamped2} swatches`);
    await p.keyboard.press("Escape");
    await sleep(500);

    /* ---- P4: drag-select STARTING on a pdf link (no navigation) ---- */
    const linkGeo = await p.evaluate(() => {
      const as = [...document.querySelectorAll('a[data-testid="pdf-link"]')];
      const a = as.find((x) => x.getBoundingClientRect().width > 30) ?? as[0];
      if (!a) return null;
      a.scrollIntoView({ block: "center" });
      return true;
    });
    await sleep(700);
    const lg = await p.evaluate(() => {
      const as = [...document.querySelectorAll('a[data-testid="pdf-link"]')];
      const a = as.find((x) => {
        const r = x.getBoundingClientRect();
        return r.width > 30 && r.top > 80 && r.bottom < 900;
      });
      if (!a) return null;
      const r = a.getBoundingClientRect();
      return { x: r.left + 4, y: r.top + r.height / 2 };
    });
    check("P4: a pdf link is on screen", !!linkGeo && !!lg);
    if (lg) {
      const urlBeforeDrag = p.url();
      await p.mouse.move(lg.x, lg.y);
      await p.mouse.down();
      await p.mouse.move(lg.x + 100, lg.y, { steps: 10 }); // > 3px click-vs-drag threshold
      await p.mouse.up();
      await sleep(900);
      check("P4: drag over a link selects text (palette appears)", await p.evaluate(() =>
        !!document.querySelector("[data-seltoolbar]")));
      check("P4: no navigation happened", p.url() === urlBeforeDrag);
      check("P4: link anchors are draggable=false", await p.evaluate(() =>
        [...document.querySelectorAll('a[data-testid="pdf-link"]')]
          .every((a) => a.draggable === false)));
      await p.mouse.click(400, 30); // header title area — dismisses the palette
      await sleep(500);
    }

    /* ---- P5: aborted PDF fetch -> error card + Try again recovers ---- */
    // Abort EVERY pdf (uploads bucket) request until the error UI is on
    // screen — aborting just the first storage hit was flaky (it could be an
    // element image, and the pdf then loaded fine).
    let blockPdf = true;
    await p.route("**/storage/v1/**", (route) => {
      if (blockPdf && route.request().url().includes("/uploads/")) return route.abort();
      return route.continue();
    });
    await p.reload({ waitUntil: "domcontentloaded" });
    let errUi = null;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      errUi = await p.evaluate(() => {
        const txt = document.body.textContent || "";
        if (!txt.includes("The PDF could not be loaded.")) return null;
        const btn = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Try again");
        return { retry: !!btn };
      });
      if (errUi) break;
    }
    check("P5: no white screen — load-error message shown", !!errUi);
    check("P5: Try again button offered", !!errUi && errUi.retry);
    blockPdf = false;
    await p.unroute("**/storage/v1/**");
    if (errUi?.retry) {
      await p.evaluate(() => {
        [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Try again")?.click();
      });
      let canvasBack = false;
      try {
        await p.waitForSelector(".rd-pdf-page canvas", { timeout: 45000 });
        canvasBack = true;
      } catch { /* stays false */ }
      check("P5: Try again recovers — pages render", canvasBack);
      await sleep(2500);
    } else {
      await openDoc(p); // recover for the rest of the suite either way
    }

    /* ================= Cards ================= */

    /* ---- C1: delete while streaming -> no stuck busy, undo restores + merges ---- */
    const idA = await makeHighlight(p, 1, "blue");
    hlIds.push(idA);
    await p.keyboard.press("Escape");
    await sleep(400);
    const idB = await makeHighlight(p, 2, "amber");
    hlIds.push(idB);
    check("C1: two highlights ready", !!idA && !!idB, `${idA} / ${idB}`);
    const q1 = "Pe scurt: explica pasajul.";
    await p.fill(`[data-card="${idB}"] textarea`, q1);
    await p.press(`[data-card="${idB}"] textarea`, "Enter"); // AI call 1
    const baseB = await cardText(p, idB);
    const streamed = await waitFirstToken(p, idB, baseB - 5, 120000);
    check("C1: stream started (has real text)", streamed);
    const lenAtDelete = await cardText(p, idB);
    await p.evaluate((id) =>
      document.querySelector(`[data-card="${id}"] button[aria-label="Delete highlight and thread"]`)?.click(), idB);
    await sleep(700);
    check("C1: undo toast appears", await p.evaluate(() =>
      !!document.querySelector('[data-testid="undo-toast"] button[aria-label="Undo delete"]')));
    // a DIFFERENT thread must accept input right away (no stuck busy)
    await openOverlay(p, idA);
    let typedOk = false;
    try {
      await p.fill(`[data-card="${idA}"] textarea`, "proba", { timeout: 3000 });
      typedOk = (await p.evaluate((id) =>
        document.querySelector(`[data-card="${id}"] textarea`)?.value, idA)) === "proba";
    } catch { /* stays false */ }
    check("C1: another card's textarea accepts input within 3s", typedOk);
    await p.fill(`[data-card="${idA}"] textarea`, "");
    await p.click('button[aria-label="Undo delete"]');
    await sleep(1000);
    check("C1: undo restores the highlight overlay", await p.evaluate((id) =>
      !!document.querySelector(`.pdf-overlay[data-owner="${id}"]`), idB));
    await openOverlay(p, idB);
    // KEY: once the stream (continued/saved server-side) is over, the partial
    // or full answer must be present in the restored card (merge behavior).
    let mergedLen = 0;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      mergedLen = await cardText(p, idB);
      if (mergedLen >= Math.max(lenAtDelete - 10, baseB + 30)) break;
    }
    check("C1: restored card holds the answer text after the stream ends",
      mergedLen >= Math.max(lenAtDelete - 10, baseB + 30), `${mergedLen} chars (was ${lenAtDelete} at delete)`);
    await waitStreamEnd(p, idB, 120000);

    /* ---- C2: blocked-send hint while another thread streams ---- */
    const qLong = "Explica pe larg, in detaliu, tot experimentul, metodele si rezultatele.";
    await p.fill(`[data-card="${idB}"] textarea`, qLong);
    await p.press(`[data-card="${idB}"] textarea`, "Enter"); // AI call 2 (long, shared by C2+C3)
    await waitFirstToken(p, idB, await cardText(p, idB) - 5, 120000);
    await openOverlay(p, idA);
    await p.fill(`[data-card="${idA}"] textarea`, "Si aici o intrebare.");
    await p.press(`[data-card="${idA}"] textarea`, "Enter");
    await sleep(700);
    const hint = await p.evaluate(() => {
      const el = document.querySelector('[data-testid="blocked-send-hint"]');
      return el ? el.textContent : null;
    });
    check("C2: blocked-send hint shown in the other card", !!hint && /another conversation/i.test(hint), hint ?? "");
    await p.fill(`[data-card="${idA}"] textarea`, "");

    /* ---- C3: scroll freedom during streaming + Scroll to latest ---- */
    await openOverlay(p, idB);
    let scrollable = false;
    for (let i = 0; i < 60; i++) {
      scrollable = await p.evaluate((id) => {
        const sc = document.querySelector(`[data-card="${id}"] .overflow-y-auto`);
        return !!sc && sc.scrollHeight > sc.clientHeight + 250;
      }, idB);
      if (scrollable) break;
      await sleep(1000);
    }
    check("C3: streaming answer grew tall enough to scroll", scrollable);
    if (scrollable) {
      const st0 = await p.evaluate((id) => {
        const sc = document.querySelector(`[data-card="${id}"] .overflow-y-auto`);
        sc.scrollTop = Math.max(0, sc.scrollTop - 200);
        sc.dispatchEvent(new Event("scroll", { bubbles: true }));
        return sc.scrollTop;
      }, idB);
      await sleep(1200);
      const st1 = await p.evaluate((id) =>
        document.querySelector(`[data-card="${id}"] .overflow-y-auto`).scrollTop, idB);
      check("C3: scroll position respected while streaming (not yanked down)", st1 <= st0 + 40, `${st0} -> ${st1}`);
      check("C3: 'Scroll to latest' button visible", await p.evaluate(() =>
        !!document.querySelector('button[aria-label="Scroll to latest"]')));
      await p.click('button[aria-label="Scroll to latest"]').catch(() => {});
      await sleep(700);
      const atBottom = await p.evaluate((id) => {
        const sc = document.querySelector(`[data-card="${id}"] .overflow-y-auto`);
        return sc.scrollHeight - sc.clientHeight - sc.scrollTop < 60;
      }, idB);
      check("C3: Scroll to latest returns to the bottom", atBottom);
    }
    // stop the long stream — its job is done
    await p.evaluate((id) =>
      document.querySelector(`[data-card="${id}"] button[aria-label="Stop generating"]`)?.click(), idB);
    await sleep(2000);

    /* ---- C4: interrupted marker after a mid-stream reload ---- */
    await p.fill(`[data-card="${idB}"] textarea`, "Explica pe larg metodologia studiului.");
    await p.press(`[data-card="${idB}"] textarea`, "Enter"); // AI call 3
    await sleep(2000); // reload while it is still thinking/streaming
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForSelector(".rd-pdf-page canvas", { timeout: 45000 });
    await sleep(2500);
    await openOverlay(p, idB);
    const interrupted = await p.evaluate(() => {
      const el = document.querySelector('[data-testid="answer-interrupted"]');
      if (!el) return null;
      return { askAgain: [...el.querySelectorAll("button")].some((x) => /Ask again/.test(x.textContent)) };
    });
    check("C4: interrupted marker shown after reload", !!interrupted);
    check("C4: 'Ask again' button offered", !!interrupted && interrupted.askAgain);
    await p.keyboard.press("Escape");
    await sleep(400);

    /* ---- C5: markdown table renders as a real <table> ---- */
    const idC = await makeHighlight(p, 3, "rose");
    hlIds.push(idC);
    await p.fill(`[data-card="${idC}"] textarea`,
      "Fa un tabel markdown cu 2 coloane (Nume, Valoare) si 2 randuri despre acest pasaj. Pe scurt.");
    await p.press(`[data-card="${idC}"] textarea`, "Enter"); // AI call 4
    await waitStreamEnd(p, idC, 200000);
    check("C5: markdown table rendered as <table> in a scroll wrapper", await p.evaluate((id) =>
      !!document.querySelector(`[data-card="${id}"] div.overflow-x-auto table`), idC));
    await p.keyboard.press("Escape");
    await sleep(400);

    /* ================= AI search (docked, non-modal) ================= */

    /* ---- S1: docked geometry, fixed under document scroll ---- */
    await p.evaluate(() => {
      [...document.querySelectorAll("header button")].find((x) => x.textContent.includes("AI search")).click();
    });
    await p.waitForSelector('[data-testid="aisearch-dialog"]', { timeout: 8000 });
    await sleep(500);
    const g0 = await p.evaluate(() => {
      const r = document.querySelector('[data-testid="aisearch-dialog"]').getBoundingClientRect();
      return { right: r.right, top: r.top, left: r.left, vw: window.innerWidth };
    });
    check("S1: docked to the right edge (within 20px)", g0.vw - g0.right >= -1 && g0.vw - g0.right <= 20,
      `gap ${(g0.vw - g0.right).toFixed(1)}px`);
    check("S1: top ~64px under the header", Math.abs(g0.top - 64) <= 12, `top ${g0.top.toFixed(1)}px`);
    await p.evaluate(() => {
      let el = document.querySelector(".rd-zoomport");
      while (el && !(el.scrollHeight > el.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(el).overflowY)))
        el = el.parentElement;
      if (el) el.scrollTop += 500;
    });
    await sleep(700);
    const g1 = await p.evaluate(() => {
      const r = document.querySelector('[data-testid="aisearch-dialog"]').getBoundingClientRect();
      return { right: r.right, top: r.top, left: r.left };
    });
    check("S1: position unchanged while the document scrolls (fixed)",
      Math.abs(g1.top - g0.top) <= 2 && Math.abs(g1.right - g0.right) <= 2 && Math.abs(g1.left - g0.left) <= 2);

    /* ---- S2: page jump keeps the dialog open and moves the document ---- */
    const dlgInput = await p.waitForSelector('[data-testid="aisearch-dialog"] textarea', { timeout: 8000 });
    await dlgInput.fill("In ce pagini sunt descrise metodele si rezultatele? Raspunde scurt cu citari (p. N).");
    await p.press('[data-testid="aisearch-dialog"] textarea', "Enter"); // AI call 5
    let jumpCount = 0;
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      jumpCount = await p.evaluate(() =>
        document.querySelectorAll('[data-testid="aisearch-jump"]').length);
      if (jumpCount > 0) break;
    }
    check("S2: jump buttons appear", jumpCount > 0, `${jumpCount} jumps`);
    if (jumpCount > 0) {
      // park the document at the very bottom so ANY jump changes the position
      const before = await p.evaluate(() => {
        let el = document.querySelector(".rd-zoomport");
        while (el && !(el.scrollHeight > el.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(el).overflowY)))
          el = el.parentElement;
        el.scrollTop = el.scrollHeight;
        return {
          scrollTop: el.scrollTop,
          page: document.querySelector('input[aria-label="Go to page"]')?.value ?? "",
        };
      });
      await sleep(700);
      await p.evaluate(() =>
        document.querySelector('[data-testid="aisearch-jump"]:not([disabled])')?.click());
      await sleep(1800);
      const after = await p.evaluate(() => {
        let el = document.querySelector(".rd-zoomport");
        while (el && !(el.scrollHeight > el.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(el).overflowY)))
          el = el.parentElement;
        return {
          open: !!document.querySelector('[data-testid="aisearch-dialog"]'),
          scrollTop: el.scrollTop,
          page: document.querySelector('input[aria-label="Go to page"]')?.value ?? "",
        };
      });
      check("S2: dialog STILL open after the jump (non-modal)", after.open);
      check("S2: document moved to the cited page",
        Math.abs(after.scrollTop - before.scrollTop) > 50 || after.page !== before.page,
        `scroll ${before.scrollTop} -> ${after.scrollTop}, page ${before.page} -> ${after.page}`);
    }

    /* ---- S3: jump list sanity (parser internals covered elsewhere) ---- */
    const jumpSanity = await p.evaluate(() => {
      const all = [...document.querySelectorAll('[data-testid="aisearch-jump"]')];
      const disabled = all.filter((x) => x.disabled);
      return {
        total: all.length,
        disabledOk: disabled.every((x) => x.title === "Page doesn't exist"),
      };
    });
    check("S3: at least one jump button exists", jumpSanity.total >= 1, `${jumpSanity.total}`);
    check("S3: disabled jumps say \"Page doesn't exist\"", jumpSanity.disabledOk);
    await p.evaluate(() =>
      document.querySelector('[data-testid="aisearch-dialog"] button[aria-label="Close"]')?.click());
    await sleep(500);

    /* ================= Upload ================= */

    /* ---- U1: one continuous, monotonic progress bar ---- */
    // audit.pdf finishes in ~1s locally (too few samples) — use the 7.8MB
    // figure-heavy fixture so the extraction phase is long enough to sample.
    const bigFixture = path.join(process.env.TEMP, "rd-bigpdf.pdf");
    const u1File = fs.existsSync(bigFixture) ? bigFixture : path.join(FIX, "audit.pdf");
    const fi1 = await openNewSession(p);
    const urlBeforeU1 = p.url();
    await fi1.setInputFiles(u1File);
    const widths = [];
    let navved = false;
    const tU1 = Date.now();
    while (Date.now() - tU1 < 120000) {
      const u = p.url();
      if (u !== urlBeforeU1 && u.includes("/read/")) { navved = true; break; }
      const w = await p.evaluate(() => {
        const el = document.querySelector('[data-testid="upload-progress-bar"]');
        return el ? parseFloat(el.style.width) : null;
      }).catch(() => null);
      if (typeof w === "number" && !Number.isNaN(w)) widths.push({ t: Date.now() - tU1, w });
      await sleep(250);
    }
    check("U1: upload navigates to the new document", navved, p.url());
    check("U1: continuous bar sampled", widths.length >= 3, `${widths.length} samples`);
    const monotonic = widths.every((s, i) => i === 0 || s.w >= widths[i - 1].w - 0.001);
    check("U1: bar width monotonically non-decreasing", monotonic,
      `${widths[0]?.w ?? "?"} .. ${widths[widths.length - 1]?.w ?? "?"}%`);
    let maxStall = 0;
    if (widths.length > 1) {
      let runStart = widths[0].t, runVal = widths[0].w;
      for (const s of widths.slice(1)) {
        if (s.w > runVal + 0.05) { runStart = s.t; runVal = s.w; }
        else if (runVal < 90) maxStall = Math.max(maxStall, s.t - runStart);
      }
    }
    check("U1: no freeze > 3s below 90%", maxStall <= 3500, `max stall ${maxStall}ms`);
    const u1Doc = navved ? p.url().split("/read/")[1] : null;
    if (navved) {
      await p.waitForSelector(".rd-pdf-page canvas", { timeout: 45000 }).catch(() => {});
      await sleep(2000);
      await apiDeleteDoc(p, u1Doc);
      await openDoc(p);
    }

    /* ---- U2: background upload finishes as a toast with Open ---- */
    const fi2 = await openNewSession(p);
    await fi2.setInputFiles(path.join(FIX, "audit.docx"));
    await sleep(400);
    await p.keyboard.press("Escape"); // close the dialog — upload keeps running
    await sleep(600);
    check("U2: dialog closed while the upload continues", await p.evaluate(() =>
      !document.querySelector('div[role=dialog][aria-label="New session"]')));
    let toastOk = false;
    try {
      await p.waitForSelector('[data-testid="upload-done-toast"]', { timeout: 120000 });
      toastOk = true;
    } catch { /* stays false */ }
    check("U2: completion toast appears (up to 120s, Gotenberg path)", toastOk);
    if (toastOk) {
      const hasOpen = await p.evaluate(() => {
        const t = document.querySelector('[data-testid="upload-done-toast"]');
        const a = t?.querySelector('[data-testid="upload-open-btn"]');
        return !!a && /Open/.test(a.textContent);
      });
      check("U2: toast offers an Open button", hasOpen, hasOpen ? "" :
        await p.evaluate(() => document.querySelector('[data-testid="upload-done-toast"]')?.textContent ?? ""));
      if (hasOpen) {
        const urlBeforeU2 = p.url();
        await p.click('[data-testid="upload-open-btn"]');
        let opened = false;
        try {
          await p.waitForURL((u) => u.pathname.startsWith("/read/") && u.href !== urlBeforeU2, { timeout: 60000 });
          opened = true;
        } catch { /* stays false */ }
        check("U2: Open lands on the new document", opened, p.url());
        if (opened) {
          const u2Doc = p.url().split("/read/")[1];
          await sleep(2500);
          await apiDeleteDoc(p, u2Doc);
          await openDoc(p);
        }
      }
    }

    /* ---- U3: cancel resets, no navigation ---- */
    const u3File = ["audit.mobi", "audit.epub", "audit.docx"]
      .map((f) => path.join(FIX, f)).find((f) => fs.existsSync(f)) ?? path.join(FIX, "audit.pdf");
    const fi3 = await openNewSession(p);
    const urlBeforeU3 = p.url();
    await fi3.setInputFiles(u3File);
    const cancelBtn = await p.waitForSelector('[data-testid="upload-cancel"]', { timeout: 10000 }).catch(() => null);
    if (cancelBtn) await cancelBtn.click();
    await sleep(1200);
    check("U3: cancel button shown and clicked", !!cancelBtn, path.basename(u3File));
    check("U3: progress reset — dialog back to the drop zone", await p.evaluate(() => {
      const dlg = document.querySelector('div[role=dialog][aria-label="New session"]');
      return !!dlg && !dlg.querySelector('[data-testid="upload-progress"]') &&
        [...dlg.querySelectorAll("button")].some((x) => x.textContent.includes("Choose a file"));
    }));
    await sleep(10000);
    check("U3: no navigation within 10s of cancelling", p.url() === urlBeforeU3);
    await p.keyboard.press("Escape");
    await sleep(500);

    /* ---- U4: scanned (image-only) PDF opens with the scanned banner ---- */
    const fi4 = await openNewSession(p);
    const urlBeforeU4 = p.url();
    await fi4.setInputFiles(path.join(FIX, "scanned.pdf"));
    let scannedNav = false;
    try {
      await p.waitForURL((u) => u.pathname.startsWith("/read/") && u.href !== urlBeforeU4, { timeout: 120000 });
      scannedNav = true;
    } catch { /* stays false */ }
    check("U4: scanned.pdf uploads and opens", scannedNav, p.url());
    if (scannedNav) {
      const u4Doc = p.url().split("/read/")[1];
      await p.waitForSelector(".rd-pdf-page canvas", { timeout: 45000 }).catch(() => {});
      await sleep(2500);
      const banner = await p.evaluate(() => {
        const el = document.querySelector('[data-testid="scanned-banner"]');
        return el ? el.textContent : null;
      });
      check("U4: scanned banner present", !!banner, (banner ?? "").slice(0, 60));
      check("U4: banner points the reader to Capture", !!banner && /capture/i.test(banner));
      await apiDeleteDoc(p, u4Doc);
      await openDoc(p);
    } else {
      // recover the reader if the upload dialog is still up
      await p.keyboard.press("Escape");
      await sleep(400);
    }

    /* ---- U5: failed doc surfaces as a muted, unclickable Recents row ---- */
    const admin = createClient("http://127.0.0.1:54321", LOCAL_SERVICE, { auth: { persistSession: false } });
    const { data: userList } = await admin.auth.admin.listUsers();
    const owner = userList.users.find((u) => u.email === "dev@local.test").id;
    const { data: ghost, error: ghostErr } = await admin.from("documents").insert({
      owner_id: owner, title: "premium-ghost-failed", kind: "pdf", status: "failed", source: "upload",
    }).select("id").single();
    if (ghostErr) throw new Error(ghostErr.message);
    await p.evaluate(() => {
      [...document.querySelectorAll("header button")].find((x) => x.textContent.includes("Recents")).click();
    });
    await sleep(1500);
    const failedRow = await p.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="recents-row-failed"]')];
      const row = rows.find((r) => (r.textContent || "").includes("premium-ghost-failed"));
      return row ? { text: (row.textContent || "").slice(0, 60), hasLink: !!row.querySelector("a") } : null;
    });
    check("U5: failed row rendered in Recents", !!failedRow, failedRow?.text ?? "no row");
    check("U5: row shows 'Failed' and is not a link", !!failedRow && /Failed/.test(failedRow.text) && !failedRow.hasLink);
    await p.keyboard.press("Escape");
    await sleep(500);
    await admin.from("documents").delete().eq("id", ghost.id);

    /* ---- U6: Recents fetch error -> retryable state ---- */
    let recentsFailed = false;
    await p.route("**/api/recents*", (route) => {
      if (!recentsFailed) {
        recentsFailed = true;
        return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' });
      }
      return route.continue();
    });
    await p.evaluate(() => {
      [...document.querySelectorAll("header button")].find((x) => x.textContent.includes("Recents")).click();
    });
    await sleep(1200);
    const errState = await p.evaluate(() => ({
      msg: /Couldn.t load your sessions\./.test(document.body.textContent || ""),
      retry: !!document.querySelector('[data-testid="recents-retry"]'),
    }));
    check("U6: error message shown instead of an empty account", errState.msg);
    check("U6: Retry button offered", errState.retry);
    await p.unroute("**/api/recents*");
    await p.evaluate(() => document.querySelector('[data-testid="recents-retry"]')?.click());
    await sleep(2000);
    check("U6: Retry loads the sessions", await p.evaluate(() =>
      !!document.querySelector('a[href^="/read/"]') &&
      !/Couldn.t load your sessions\./.test(document.body.textContent || "")));
    await p.keyboard.press("Escape");
    await sleep(500);

    /* ---- U7: corrupt PDF refused with a clear message ---- */
    if (fs.existsSync(path.join(FIX, "corrupt.pdf"))) {
      const fi7 = await openNewSession(p);
      const urlBeforeU7 = p.url();
      await fi7.setInputFiles(path.join(FIX, "corrupt.pdf"));
      let corruptMsg = "";
      for (let i = 0; i < 90; i++) {
        await sleep(1000);
        if (p.url() !== urlBeforeU7) break;
        corruptMsg = await p.evaluate(() => {
          const dlg = document.querySelector('div[role=dialog][aria-label="New session"]');
          const e = dlg && [...dlg.querySelectorAll("p")]
            .find((x) => /corrupt|not a valid|failed|could not/i.test(x.textContent));
          return e ? e.textContent : "";
        }).catch(() => "");
        if (corruptMsg) break;
      }
      check("U7: corrupt pdf rejected with a clear message",
        /corrupted|not a valid PDF/i.test(corruptMsg), corruptMsg || "no message");
      check("U7: no navigation on the corrupt upload", p.url() === urlBeforeU7);
      await p.keyboard.press("Escape");
      await sleep(500);
    } else {
      console.log("U7: corrupt.pdf fixture missing — run scripts/audit-fixtures.js first");
      fail++;
    }
    // encrypted.pdf: SKIPPED — no PDF encryption library available in
    // node_modules (see the note in scripts/audit-fixtures.js).
    console.log("U7: encrypted.pdf check skipped (fixture not buildable without a PDF encryption lib)");

    /* ================= Reader integration ================= */

    await openDoc(p); // clean state on the zebra doc

    /* ---- R1: ctrl+wheel zooms the document column only ---- */
    const z0 = await p.evaluate(() => ({
      page: document.querySelector('[data-page="1"]').getBoundingClientRect().width,
      margin: document.querySelector("[data-margin-col]").getBoundingClientRect().width,
    }));
    const p1c = await p.evaluate(() => {
      const r = document.querySelector('[data-page="1"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: Math.min(Math.max(r.top + 200, 200), 700) };
    });
    await p.mouse.move(p1c.x, p1c.y);
    await p.keyboard.down("Control");
    await p.mouse.wheel(0, -120);
    await sleep(350);
    await p.mouse.wheel(0, -120);
    await p.keyboard.up("Control");
    await sleep(1200);
    const z1 = await p.evaluate(() => ({
      page: document.querySelector('[data-page="1"]').getBoundingClientRect().width,
      margin: document.querySelector("[data-margin-col]").getBoundingClientRect().width,
    }));
    check("R1: ctrl+wheel up zooms the page >= 1.2x", z1.page >= z0.page * 1.2,
      `${z0.page.toFixed(0)} -> ${z1.page.toFixed(0)}px (${(z1.page / z0.page).toFixed(2)}x)`);
    check("R1: margin column width unchanged", Math.abs(z1.margin - z0.margin) <= 2,
      `${z0.margin.toFixed(0)} -> ${z1.margin.toFixed(0)}px`);
    await p.mouse.move(p1c.x, p1c.y);
    await p.keyboard.down("Control");
    await p.mouse.wheel(0, 120);
    await sleep(350);
    await p.mouse.wheel(0, 120);
    await p.keyboard.up("Control");
    await sleep(1200);
    const z2 = await p.evaluate(() =>
      document.querySelector('[data-page="1"]').getBoundingClientRect().width);
    check("R1: ctrl+wheel down returns toward 100%", z2 <= z0.page * 1.05,
      `${z2.toFixed(0)}px vs base ${z0.page.toFixed(0)}px`);
    await p.evaluate((id) => localStorage.removeItem(`rd-zoom-${id}`), ZEBRA);

    /* ---- R2: Esc hierarchy — dialog first, then card; capture doesn't eat the card ---- */
    const idD = await makeHighlight(p, 4, "blue");
    hlIds.push(idD);
    await p.evaluate(() => {
      [...document.querySelectorAll("header button")].find((x) => x.textContent.includes("AI search")).click();
    });
    await p.waitForSelector('[data-testid="aisearch-dialog"]', { timeout: 8000 });
    await sleep(400);
    await p.keyboard.press("Escape");
    await sleep(500);
    const esc1 = await p.evaluate((id) => ({
      dlg: !!document.querySelector('[data-testid="aisearch-dialog"]'),
      card: !!document.querySelector(`[data-card="${id}"] textarea`),
    }), idD);
    check("R2: first Esc closes ONLY the AI-search dialog", !esc1.dlg && esc1.card, JSON.stringify(esc1));
    await p.keyboard.press("Escape");
    await sleep(500);
    check("R2: second Esc collapses the card", await p.evaluate((id) =>
      !document.querySelector(`[data-card="${id}"] textarea`), idD));
    await openOverlay(p, idD);
    await p.evaluate(() => {
      [...document.querySelectorAll("header button")].find((x) => /Capture|Draw a box/.test(x.textContent)).click();
    });
    await sleep(900);
    await p.keyboard.press("Escape");
    await sleep(500);
    const esc2 = await p.evaluate(() => ({
      captureOff: [...document.querySelectorAll("header button")]
        .some((x) => x.textContent.trim().includes("Capture") && !/Draw a box/.test(x.textContent)),
    }));
    // (Clicking the Capture header button already collapses the open card by
    // the click-outside design, so only the capture cancellation is asserted.)
    check("R2: Esc with capture armed cancels capture", esc2.captureOff, JSON.stringify(esc2));
    await p.keyboard.press("Escape");
    await sleep(400);

    /* ---- R3: unified error banner with Dismiss ---- */
    let hlPostFailed = false;
    await p.route("**/api/highlights*", (route) => {
      if (!hlPostFailed && route.request().method() === "POST") {
        hlPostFailed = true;
        return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' });
      }
      return route.continue();
    });
    await makeHighlight(p, 5, "blue"); // the POST 500s — no card should appear
    await sleep(800);
    const banner = await p.evaluate(() =>
      !!document.querySelector('button[aria-label="Dismiss error"]'));
    check("R3: error banner appears with a Dismiss button", banner);
    await p.evaluate(() => document.querySelector('button[aria-label="Dismiss error"]')?.click());
    await sleep(500);
    check("R3: Dismiss clears the banner", await p.evaluate(() =>
      !document.querySelector('button[aria-label="Dismiss error"]')));
    await p.unroute("**/api/highlights*");

    /* ---------- cleanup ---------- */
    const cleaned = await p.evaluate(async (ids) => {
      const out = [];
      for (const id of ids.filter(Boolean)) out.push((await fetch(`/api/highlights/${id}`, { method: "DELETE" })).ok);
      return out;
    }, hlIds);
    // safety net: uploads whose docs survived a failed check (titles are fixture-specific)
    await p.evaluate(async () => {
      const rec = await (await fetch("/api/recents")).json();
      for (const s of rec.sessions ?? []) {
        if (/^(audit|scanned|corrupt|premium-ghost)/.test(s.title)) {
          await fetch(`/api/documents/${s.documentId}`, { method: "DELETE" });
        }
      }
    }).catch(() => {});
    console.log("cleanup:", JSON.stringify(cleaned));
  } catch (err) {
    fail++;
    console.log("FAIL suite crashed:", err.message);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
