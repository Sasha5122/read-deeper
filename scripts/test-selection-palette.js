/**
 * Selection palette battery: anchored at the END of the selected words,
 * rides with the scroll, dismissed by an outside click, expires after 10s.
 */
const puppeteer = require("puppeteer-core");
const CHROME = process.env.TEMP + "/rd-chrome/chrome/win64-152.0.7977.82/chrome-win64/chrome.exe";
const DOC = "27f352a4-bb4c-4074-a3d7-96a72841a90f";

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log("PASS", name, extra); }
  else { fail++; console.log("FAIL", name, extra); }
}

async function paletteBox(p) {
  return await p.evaluate(() => {
    const t = document.querySelector("div[role=toolbar][data-seltoolbar]");
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { left: r.left, top: r.top, visible: getComputedStyle(t).visibility !== "hidden" };
  });
}

async function selEndRect(p) {
  return await p.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const rects = [...sel.getRangeAt(0).getClientRects()].filter((r) => r.width > 0);
    const last = rects[rects.length - 1];
    return last ? { right: last.right, bottom: last.bottom, top: last.top } : null;
  });
}

async function dragSelect(p) {
  const geo = await p.evaluate(() => {
    const spans = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')];
    const s1 = spans.find((s) => (s.textContent || "").length > 40);
    if (!s1) return null;
    const r = s1.getBoundingClientRect();
    return { x1: r.left + 3, y1: r.top + r.height / 2, x2: r.left + r.width * 0.6, y2: r.top + r.height / 2 };
  });
  if (!geo) return false;
  await p.mouse.move(geo.x1, geo.y1);
  await p.mouse.down();
  await p.mouse.move(geo.x2, geo.y2, { steps: 12 });
  await p.mouse.up();
  await new Promise((r) => setTimeout(r, 700));
  return true;
}

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage();
  await p.setViewport({ width: 1920, height: 950 });
  await p.goto(`http://localhost:3000/read/${DOC}`, { waitUntil: "networkidle2", timeout: 90000 });
  await p.waitForSelector(".rd-pdf-page canvas", { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2800));
  await p.evaluate(() => localStorage.clear());

  /* 1 — select words, palette appears anchored at the END of the selection */
  check("drag selection made", await dragSelect(p));
  let end = await selEndRect(p);
  let box = await paletteBox(p);
  check("palette appears", !!box && box.visible);
  if (box && end) {
    check(
      "palette anchored at end of last word (x)",
      Math.abs(box.left - (end.right + 6)) < 4,
      `palette.left=${box.left.toFixed(0)} sel.right+6=${(end.right + 6).toFixed(0)}`,
    );
    check(
      "palette sits just under the last line (y)",
      Math.abs(box.top - (end.bottom + 8)) < 4,
      `palette.top=${box.top.toFixed(0)} sel.bottom+8=${(end.bottom + 8).toFixed(0)}`,
    );
  }
  await p.screenshot({ path: "v-palette-anchor.png" });

  /* 2 — scroll 150px: palette must ride with the content, not stay fixed */
  const before = box;
  await p.evaluate(() => {
    const sc = document.querySelector(".rd-capture-cursor, main div[class*=overflow-y-auto]");
    const el = sc || [...document.querySelectorAll("div")].find((d) => d.scrollHeight > d.clientHeight + 200 && d.clientHeight > 500);
    el.scrollTop += 150;
  });
  await new Promise((r) => setTimeout(r, 500));
  box = await paletteBox(p);
  check(
    "palette moves WITH the text on scroll (150px up)",
    !!box && Math.abs(before.top - box.top - 150) < 3,
    box ? `before.top=${before.top.toFixed(0)} after.top=${box.top.toFixed(0)}` : "palette gone",
  );
  await p.screenshot({ path: "v-palette-scrolled.png" });

  /* 3 — scroll far: anchor leaves the viewport, palette hides */
  await p.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find((d) => d.scrollHeight > d.clientHeight + 200 && d.clientHeight > 500);
    el.scrollTop += 1400;
  });
  await new Promise((r) => setTimeout(r, 500));
  box = await paletteBox(p);
  check("palette hidden once anchor scrolls away", !box || !box.visible, box ? `visible=${box.visible}` : "unmounted");

  /* 4 — scroll back: visible again */
  await p.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find((d) => d.scrollHeight > d.clientHeight + 200 && d.clientHeight > 500);
    el.scrollTop -= 1550;
  });
  await new Promise((r) => setTimeout(r, 500));
  box = await paletteBox(p);
  check("palette visible again after scrolling back", !!box && box.visible);

  /* 5 — click anywhere else: palette + selection disappear */
  await p.mouse.click(1700, 120); // empty margin area
  await new Promise((r) => setTimeout(r, 400));
  box = await paletteBox(p);
  const selAfterClick = await p.evaluate(() => (window.getSelection()?.toString() ?? "").length);
  check("outside click dismisses palette", !box);
  check("outside click collapses selection", selAfterClick === 0, `selLen=${selAfterClick}`);

  /* 6 — no interaction for 10s: palette expires on its own */
  check("re-selection made", await dragSelect(p));
  box = await paletteBox(p);
  check("palette re-appeared", !!box);
  await new Promise((r) => setTimeout(r, 10600));
  box = await paletteBox(p);
  const selAfterWait = await p.evaluate(() => (window.getSelection()?.toString() ?? "").length);
  check("palette expires after 10s untouched", !box);
  check("selection cleared after 10s untouched", selAfterWait === 0, `selLen=${selAfterWait}`);

  /* 7 — picking a colour still works (palette not broken by the listener) */
  check("selection for colour pick", await dragSelect(p));
  const madeBefore = await p.evaluate(() => document.querySelectorAll(".pdf-overlay[data-owner]").length);
  await p.evaluate(() => {
    const btn = document.querySelector('div[role=toolbar] button[aria-label*="amber"]');
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 1800));
  const madeAfter = await p.evaluate(() => document.querySelectorAll(".pdf-overlay[data-owner]").length);
  check("colour pick still creates a highlight", madeAfter > madeBefore, `${madeBefore} -> ${madeAfter}`);
  // clean up the created highlight
  const newId = await p.evaluate(() => {
    const ids = [...new Set([...document.querySelectorAll(".pdf-overlay[data-hl]")].map((d) => d.getAttribute("data-hl")))];
    return ids[ids.length - 1];
  });
  if (madeAfter > madeBefore && newId) {
    await p.evaluate(async (hid) => { await fetch(`/api/highlights/${hid}`, { method: "DELETE" }); }, newId);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
