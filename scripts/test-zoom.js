/**
 * Zoom battery: header zoom control (100..250%), zoomport panning, sticky
 * pan bar sync, overlays glued to text at zoom, connector lines re-anchoring
 * while panning, margin column and cards immobile, reset to 100%.
 *
 * Run: node scripts/test-zoom.js   (app on :3000, doc must exist)
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
const fmt = (n) => (typeof n === "number" ? n.toFixed(1) : String(n));

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage();
  const pageErrors = [];
  p.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e).slice(0, 200)));
  await p.setViewport({ width: 1920, height: 950 });
  // zoom persists per doc — start every run from a clean 100%
  await p.evaluateOnNewDocument((doc) => {
    try { localStorage.removeItem("rd-zoom-" + doc); } catch {}
  }, DOC);
  await p.goto(`http://localhost:3000/read/${DOC}`, { waitUntil: "networkidle2", timeout: 90000 });
  await p.waitForSelector(".rd-pdf-page canvas", { timeout: 30000 });
  await sleep(3000);

  /* ---------- helpers evaluated in the page ---------- */
  const readState = () => p.evaluate(() => {
    const page1 = document.querySelector('[data-page="1"]');
    const pr = page1 ? page1.getBoundingClientRect() : null;
    const margin = document.querySelector("[data-margin-col]");
    const label = document.querySelector('button[title="Reset zoom"]');
    const scroller = document.querySelector(".rd-zoomport")?.closest(".overflow-y-auto");
    return {
      pageW: pr ? pr.width : null,
      pageLeft: pr ? pr.left : null,
      marginLeft: margin ? margin.getBoundingClientRect().left : null,
      zoomLabel: label ? (label.textContent || "").trim() : null,
      panbar: !!document.querySelector('[data-testid="zoom-panbar"]'),
      scrollTop: scroller ? scroller.scrollTop : null,
    };
  });

  // rect of the FIRST text-highlight overlay for `owner` on page 1 + union bbox
  const ownerOverlay = (owner) => p.evaluate((own) => {
    const page1 = document.querySelector('[data-page="1"]');
    const ovs = [...page1.querySelectorAll(".pdf-overlay[data-owner]")]
      .filter((o) => o.getAttribute("data-owner") === own);
    if (!ovs.length) return null;
    let L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
    for (const o of ovs) {
      const r = o.getBoundingClientRect();
      L = Math.min(L, r.left); T = Math.min(T, r.top);
      R = Math.max(R, r.right); B = Math.max(B, r.bottom);
    }
    const fr = ovs[ovs.length - 1].getBoundingClientRect(); // last line = connector anchor
    return { count: ovs.length, left: L, top: T, right: R, bottom: B,
             aLeft: fr.left, aTop: fr.top, aRight: fr.right, aBottom: fr.bottom };
  }, owner);

  // connector path whose "M x y" start sits nearest the given viewport point
  const nearestPathStart = (px, py) => p.evaluate((x0, y0) => {
    const svg = document.querySelector("svg.absolute.z-10");
    if (!svg) return null;
    const sr = svg.getBoundingClientRect();
    let best = null;
    for (const el of svg.querySelectorAll("path")) {
      const m = /M\s*([-\d.]+)[ ,]+([-\d.]+)/.exec(el.getAttribute("d") || "");
      if (!m) continue;
      const x = +m[1], y = +m[2];
      const d = Math.hypot(sr.left + x - x0, sr.top + y - y0);
      if (!best || d < best.dist) best = { x, y, vx: sr.left + x, vy: sr.top + y, dist: d };
    }
    return best;
  }, px, py);

  const cardLefts = () => p.evaluate(() =>
    [...document.querySelectorAll("[data-card]")].map((c) => ({
      id: c.getAttribute("data-card"), left: c.getBoundingClientRect().left })));

  /* ================= 1. BASELINE at 100% ================= */
  const base = await readState();
  check("1: page-1 rendered at 100%", base.pageW && base.pageW > 300, `W0=${fmt(base.pageW)}`);
  check("1: zoom label shows 100%", base.zoomLabel === "100%", `label=${base.zoomLabel}`);
  check("1: margin column present", base.marginLeft !== null, `M0=${fmt(base.marginLeft)}`);
  check("1: no panbar at 100%", !base.panbar);

  // pick a text highlight overlay on page 1, preferring one in the left 55%
  // of the page (stays inside the visible column at 150%, connector unclamped)
  const picked = await p.evaluate(() => {
    const page1 = document.querySelector('[data-page="1"]');
    const pr = page1.getBoundingClientRect();
    const ovs = [...page1.querySelectorAll(".pdf-overlay[data-owner]:not([data-hl])")];
    const info = (o) => {
      const r = o.getBoundingClientRect();
      return { owner: o.getAttribute("data-owner"),
               left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const good = ovs.find((o) => {
      const r = o.getBoundingClientRect();
      return r.width > 5 && r.right < pr.left + pr.width * 0.55;
    });
    return good ? info(good) : (ovs[0] ? info(ovs[0]) : null);
  });
  check("1: tracked overlay found on page 1", !!picked,
    picked ? `owner=${picked.owner} rect=(${fmt(picked.left)},${fmt(picked.top)})` : "none");

  // all overlay positions (for the reset check)
  const baseOverlays = await p.evaluate(() => {
    return [...document.querySelectorAll(".pdf-overlay[data-owner]")].map((o, i) => {
      const r = o.getBoundingClientRect();
      return { key: o.getAttribute("data-owner") + "#" + i, left: r.left, top: r.top };
    });
  });
  await p.screenshot({ path: "v-zoom-100.png" });

  /* ================= 2. ZOOM 150% ================= */
  await p.click('button[aria-label="Zoom in"]');
  await sleep(500);
  await p.click('button[aria-label="Zoom in"]');
  await sleep(2500);
  const z150 = await readState();
  const ratio = z150.pageW / base.pageW;
  check("2: page width ~ W0*1.5 (±3%)", Math.abs(z150.pageW - base.pageW * 1.5) <= base.pageW * 1.5 * 0.03,
    `W=${fmt(z150.pageW)} ratio=${ratio.toFixed(3)}`);
  check("2: label shows 150%", z150.zoomLabel === "150%", `label=${z150.zoomLabel}`);
  check("2: panbar exists at 150%", z150.panbar);
  check("2: margin column did not move (±2px)", Math.abs(z150.marginLeft - base.marginLeft) <= 2,
    `M0=${fmt(base.marginLeft)} now=${fmt(z150.marginLeft)}`);

  /* ================= 3a. OVERLAY STILL ON TEXT at 150% ================= */
  const onText = picked && await p.evaluate((own) => {
    const page1 = document.querySelector('[data-page="1"]');
    const ov = [...page1.querySelectorAll(".pdf-overlay[data-owner]")]
      .find((o) => o.getAttribute("data-owner") === own);
    if (!ov) return { found: false };
    const r = ov.getBoundingClientRect();
    const hit = [...page1.querySelectorAll(".pdf-textlayer span")].some((s) => {
      const sr = s.getBoundingClientRect();
      return sr.width > 0 && (s.textContent || "").trim().length > 0 &&
        sr.left < r.right && sr.right > r.left && sr.top < r.bottom && sr.bottom > r.top;
    });
    return { found: true, hit, left: r.left, top: r.top };
  }, picked.owner);
  check("3: tracked overlay intersects a text span at 150%", !!(onText && onText.found && onText.hit),
    onText && onText.found ? `overlay=(${fmt(onText.left)},${fmt(onText.top)})` : "overlay missing at 150%");
  await p.screenshot({ path: "v-zoom-150.png" });

  /* ================= 3b. NEW HIGHLIGHT AT ZOOM ================= */
  const geo = await p.evaluate(() => {
    const spans = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')];
    const s = spans.find((x) => {
      const t = (x.textContent || "").trim();
      const r = x.getBoundingClientRect();
      return t.length >= 25 && r.top > 140 && r.bottom < 880 && r.left > 210 && r.right < 1400 && r.width > 150;
    });
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return { x1: r.left + 2, y1: r.top + r.height / 2, x2: r.left + r.width * 0.7, y2: r.top + r.height / 2 };
  });
  check("3: found a selectable line at 150%", !!geo, geo ? `from ${fmt(geo.x1)},${fmt(geo.y1)}` : "");
  let newId = null;
  if (geo) {
    await p.mouse.move(geo.x1, geo.y1);
    await p.mouse.down();
    await p.mouse.move(geo.x2, geo.y2, { steps: 12 });
    await p.mouse.up();
    await sleep(700);
    const selRect = await p.evaluate(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    check("3: live selection captured before palette click", !!selRect,
      selRect ? `sel=(${fmt(selRect.left)}..${fmt(selRect.right)})` : "");
    await p.evaluate(() => document.querySelector('div[role=toolbar] button[aria-label*="amber"]')?.click());
    await sleep(1800);
    newId = await p.evaluate(() =>
      document.querySelector("[data-card] textarea")?.closest("[data-card]")?.getAttribute("data-card"));
    check("3: new highlight created at 150%", !!newId, `id=${newId}`);
    if (newId && selRect) {
      const ov = await ownerOverlay(newId);
      // Horizontal must match the selection exactly (±3px). Vertically the
      // overlay hugs the pdf.js text-layer SPAN box (PdfView drawRange uses
      // span rect top/height) while the native selection Range rect is the
      // glyph inline box, which overhangs the span box by ~2px above/~1px
      // below already at 100% (measured t=+2.0 b=-0.7) and scales with zoom
      // (t=+4.0 b=-3.0 at 150%). So vertically we require the centers within
      // 3px and edges within 6px (= the 100% metric gap x1.5 + rounding) — a
      // real zoom-anchoring bug is off by a full line (~27px) or more.
      const cSel = (selRect.top + selRect.bottom) / 2;
      const cOv = ov ? (ov.top + ov.bottom) / 2 : NaN;
      const near = ov &&
        Math.abs(ov.left - selRect.left) <= 3 && Math.abs(ov.right - selRect.right) <= 3 &&
        Math.abs(cOv - cSel) <= 3 &&
        Math.abs(ov.top - selRect.top) <= 6 && Math.abs(ov.bottom - selRect.bottom) <= 6;
      check("3: new overlay on the live selection (h ±3px, v center ±3px)", !!near,
        ov ? `d(l,r,t,b)=(${fmt(ov.left - selRect.left)},${fmt(ov.right - selRect.right)},${fmt(ov.top - selRect.top)},${fmt(ov.bottom - selRect.bottom)}) dCenter=${fmt(cOv - cSel)}`
           : "no overlay for new id");
    }
    // delete through the UI so the reader state stays clean for checks 4-6,
    // then confirm on the API that the row is gone
    if (newId) {
      await p.evaluate((id) => {
        document.querySelector(`[data-card="${id}"] button[aria-label="Delete highlight and thread"]`)?.click();
      }, newId);
      await sleep(1200);
      const gone = await p.evaluate(async (id) => {
        const uiGone = !document.querySelector(`.pdf-overlay[data-owner="${id}"]`);
        const res = await fetch(`/api/highlights/${id}`, { method: "DELETE" });
        return { uiGone, api: res.status };
      }, newId);
      check("3: cleanup (UI delete + API confirms gone)", gone.uiGone, `api DELETE status=${gone.api}`);
      await p.keyboard.press("Escape");
      await sleep(600);
    }
  }

  /* ================= 4. LINES ANCHORED WHILE PANNING ================= */
  let pre = null, prePath = null, preCards = null;
  if (picked) {
    pre = await ownerOverlay(picked.owner);
    if (pre) prePath = await nearestPathStart(pre.aRight, pre.aBottom);
    preCards = await cardLefts();
  }
  check("4: connector path found near tracked overlay", !!(prePath && prePath.dist < 80),
    prePath ? `start=(${fmt(prePath.x)},${fmt(prePath.y)}) dist=${fmt(prePath.dist)}` : "no svg/paths");

  // The pan bar is a CUSTOM track+thumb (no native scrollLeft): panning is
  // driven by the zoomport; the thumb mirrors it.
  const PAN = 150;
  await p.evaluate((d) => {
    const zp = document.querySelector(".rd-zoomport");
    zp.scrollLeft += d;
    zp.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, PAN);
  await sleep(800);

  if (pre && prePath) {
    const post = await ownerOverlay(picked.owner);
    const postPath = post ? await nearestPathStart(post.aRight, post.aBottom) : null;
    const ovDx = post ? post.aLeft - pre.aLeft : NaN;
    check("4: overlay moved left by ~150px (±10)", post && Math.abs(ovDx + PAN) <= 10, `dx=${fmt(ovDx)}`);
    const pathDx = postPath ? postPath.x - prePath.x : NaN;
    check("4: connector start x shifted with the text (±30)", postPath && Math.abs(pathDx + PAN) <= 30,
      `path dx=${fmt(pathDx)} (want ~-${PAN})`);
    const postCards = await cardLefts();
    const byId = Object.fromEntries(postCards.map((c) => [c.id, c.left]));
    const moved = preCards.filter((c) => byId[c.id] !== undefined && Math.abs(byId[c.id] - c.left) > 2);
    check("4: card left positions unchanged (±2px)", moved.length === 0,
      moved.length ? `moved: ${moved.map((c) => c.id.slice(0, 8)).join(",")}` : `${preCards.length} cards steady`);
  }
  await p.screenshot({ path: "v-zoom-150-panned.png" });

  /* ================= 5. PAN SYNC (custom thumb mirrors the zoomport) ===== */
  const thumbAt = async () =>
    await p.evaluate(() => {
      const t = document.querySelector('[data-testid="zoom-thumb"]');
      const zp = document.querySelector(".rd-zoomport");
      return t && zp
        ? { left: parseFloat(t.style.left) || 0, width: parseFloat(t.style.width) || 0, scroll: zp.scrollLeft }
        : null;
    });
  const t0 = await thumbAt();
  check("5: thumb rendered with real size", !!t0 && t0.width >= 40, t0 ? `w=${fmt(t0.width)}` : "no thumb");
  await p.evaluate(() => {
    const zp = document.querySelector(".rd-zoomport");
    zp.scrollLeft = 300;
    zp.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await sleep(400);
  const t300 = await thumbAt();
  check("5: zoomport 300 -> thumb slides right", !!t300 && t300.scroll === 300 && t300.left > (t0?.left ?? 0) + 10,
    t300 ? `thumb.left ${fmt(t0?.left ?? 0)} -> ${fmt(t300.left)}` : "no thumb");
  // dragging the thumb pans the zoomport (real pointer gesture)
  const drag = await p.evaluate(() => {
    const t = document.querySelector('[data-testid="zoom-thumb"]');
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await p.mouse.move(drag.x, drag.y);
  await p.mouse.down();
  await p.mouse.move(drag.x - 80, drag.y, { steps: 8 });
  await p.mouse.up();
  await sleep(400);
  const tDrag = await thumbAt();
  check("5: dragging the thumb pans the document", !!tDrag && tDrag.scroll < 300 - 30,
    tDrag ? `zoomport.scrollLeft 300 -> ${fmt(tDrag.scroll)}` : "no thumb");

  /* ================= 6. RESET via % button ================= */
  await p.click('button[title="Reset zoom"]');
  await sleep(2500);
  // vertical scroll never changed in this run, but normalize just in case
  await p.evaluate((st) => {
    const sc = document.querySelector(".rd-zoomport")?.closest(".overflow-y-auto");
    if (sc && st !== null) sc.scrollTop = st;
  }, base.scrollTop);
  await sleep(500);
  const reset = await readState();
  check("6: page width back to W0 (±2px)", Math.abs(reset.pageW - base.pageW) <= 2,
    `W0=${fmt(base.pageW)} now=${fmt(reset.pageW)}`);
  check("6: label shows 100%", reset.zoomLabel === "100%", `label=${reset.zoomLabel}`);
  check("6: panbar gone", !reset.panbar);
  const resetOverlays = await p.evaluate(() =>
    [...document.querySelectorAll(".pdf-overlay[data-owner]")].map((o, i) => {
      const r = o.getBoundingClientRect();
      return { key: o.getAttribute("data-owner") + "#" + i, left: r.left, top: r.top };
    }));
  const baseMap = Object.fromEntries(baseOverlays.map((o) => [o.key, o]));
  let offCount = 0, missing = 0, worst = 0;
  for (const o of resetOverlays) {
    const b0 = baseMap[o.key];
    if (!b0) { missing++; continue; }
    const d = Math.max(Math.abs(o.left - b0.left), Math.abs(o.top - b0.top));
    worst = Math.max(worst, d);
    if (d > 3) offCount++;
  }
  check("6: overlays back at baseline positions (±3px)",
    resetOverlays.length === baseOverlays.length && offCount === 0 && missing === 0,
    `n=${resetOverlays.length}/${baseOverlays.length} off=${offCount} unmatched=${missing} worst=${fmt(worst)}px`);

  // leave zoom persisted at 100% for the next visitor
  await p.evaluate((doc) => { try { localStorage.setItem("rd-zoom-" + doc, "1"); } catch {} }, DOC);

  /* ================= 8. NO PAGE ERRORS ================= */
  check("8: no pageerror during the run", pageErrors.length === 0, pageErrors.join(" | "));

  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
