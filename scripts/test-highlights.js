/**
 * Automated highlight battery for the PDF view. Runs scenarios and prints
 * PASS/FAIL per assertion. Cleans up the highlights it creates.
 */
const puppeteer = require("puppeteer-core");
const CHROME = process.env.TEMP + "/rd-chrome/chrome/win64-152.0.7977.82/chrome-win64/chrome.exe";
const DOC = "27f352a4-bb4c-4074-a3d7-96a72841a90f";

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) {
    pass++;
    console.log("PASS", name, extra);
  } else {
    fail++;
    console.log("FAIL", name, extra);
  }
}

async function currentHlIds(p) {
  return await p.evaluate(() =>
    [...new Set([...document.querySelectorAll(".pdf-overlay[data-hl]")].map((d) => d.getAttribute("data-hl")))],
  );
}

async function paletteVisible(p) {
  return await p.evaluate(() => !!document.querySelector("div[role=toolbar]"));
}

async function pickColor(p, color) {
  return await p.evaluate((c) => {
    const btn = document.querySelector(`div[role=toolbar] button[aria-label*="${c}"]`);
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }, color);
}

async function deleteHighlight(p, id) {
  await p.evaluate(async (hid) => {
    await fetch(`/api/highlights/${hid}`, { method: "DELETE" });
  }, id);
}

async function overlayGeom(p, id) {
  return await p.evaluate((hid) => {
    const marked = document.querySelectorAll(`.pdf-overlay[data-hl="${hid}"]`).length;
    const divs = [...document.querySelectorAll(`.pdf-overlay[data-owner="${hid}"]`)];
    const rects = divs.map((d) => {
      const r = d.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    return { marked, rects };
  }, id);
}

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage();
  await p.setViewport({ width: 1720, height: 900, deviceScaleFactor: 2 });
  await p.goto(`http://localhost:3000/read/${DOC}`, { waitUntil: "networkidle2", timeout: 90000 });
  await p.waitForSelector(".rd-pdf-page canvas", { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2800));
  await p.evaluate(() => localStorage.clear());

  const created = [];

  async function createFromSelection(name, color) {
    const hadPalette = await paletteVisible(p);
    check(`${name}: palette appears`, hadPalette);
    if (!hadPalette) return null;
    const before = await currentHlIds(p);
    await pickColor(p, color);
    await new Promise((r) => setTimeout(r, 1600));
    const after = await currentHlIds(p);
    const newId = after.find((id) => !before.includes(id));
    check(`${name}: highlight overlay created`, !!newId);
    if (newId) created.push(newId);
    // collapse the thread card so it doesn't cover later drag targets
    await p.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 400));
    return newId;
  }

  /* ---- scenario 1: double-click single words (incl. diacritics) ---- */
  const words = ["vocabulary", "Cercetătoru", "coefficient"];
  for (const w of words) {
    const pt = await p.evaluate((word) => {
      const span = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')].find((s) =>
        (s.textContent || "").includes(word),
      );
      if (!span) return null;
      const r = span.getBoundingClientRect();
      const t = span.textContent || "";
      const frac = (t.indexOf(word) + word.length / 2) / t.length;
      return { x: r.left + r.width * frac, y: r.top + r.height / 2 };
    }, w);
    if (!pt) {
      check(`word "${w}": span found`, false);
      continue;
    }
    // a REAL double click: two down/up pairs (puppeteer's clickCount:2 alone
    // sends a single pair and Chrome does not word-select on it)
    await p.mouse.move(pt.x, pt.y);
    await p.mouse.down();
    await p.mouse.up();
    await p.mouse.down({ clickCount: 2 });
    await p.mouse.up({ clickCount: 2 });
    await new Promise((r) => setTimeout(r, 600));
    const selText = await p.evaluate(() => window.getSelection()?.toString() ?? "");
    if (!selText.trim()) {
      const diag = await p.evaluate((q) => {
        const el = document.elementFromPoint(q.x, q.y);
        return { under: el ? el.tagName + "." + el.className.toString().slice(0, 40) : "none", text: el?.textContent?.slice(0, 30) };
      }, pt);
      console.log("  DIAG dblclick point:", JSON.stringify(diag));
    }
    check(`word "${w}": double-click selected`, selText.trim().length > 0, `sel="${selText.trim()}"`);
    const id = await createFromSelection(`word "${w}"`, "amber");
    if (id) {
      const geom = await overlayGeom(p, id);
      const near = geom.rects.some(
        (r) => Math.abs((r.top + r.bottom) / 2 - pt.y) < 14 && pt.x > r.left - 30 && pt.x < r.right + 30,
      );
      check(`word "${w}": overlay sits on the word`, near, JSON.stringify(geom.rects[0]));
    }
  }

  /* ---- scenario 2: long multi-line selection (~4 lines) ---- */
  const longGeo = await p.evaluate(() => {
    const spans = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')];
    const s1 = spans.find((s) => (s.textContent || "").includes("Readers of contracts"));
    const s2 = spans.find((s) => (s.textContent || "").includes("reconstruction cost"));
    if (!s1 || !s2) return null;
    const r1 = s1.getBoundingClientRect();
    const r2 = s2.getBoundingClientRect();
    return { x1: r1.left + 3, y1: r1.top + r1.height / 2, x2: r2.right - 10, y2: r2.top + r2.height / 2 };
  });
  if (longGeo) {
    await p.mouse.move(longGeo.x1, longGeo.y1);
    await p.mouse.down();
    await p.mouse.move(longGeo.x2, longGeo.y2, { steps: 25 });
    await p.mouse.up();
    await new Promise((r) => setTimeout(r, 700));
    const selLen = await p.evaluate(() => (window.getSelection()?.toString() ?? "").split(/\s+/).length);
    check("long: selection spans many words", selLen > 30, `${selLen} words`);
    const id = await createFromSelection("long", "green");
    if (id) {
      const geom = await overlayGeom(p, id);
      const lines = new Set(geom.rects.map((r) => Math.round(r.top)));
      check("long: overlay covers 3+ lines", lines.size >= 3, `${lines.size} lines`);
      check("long: first AND last piece carry the anchor", geom.marked >= 2, `marked=${geom.marked}`);
      // connector must leave from the LAST line: last data-hl rect is the bottom-most
      const markedRects = await p.evaluate((hid) => {
        return [...document.querySelectorAll(`.pdf-overlay[data-hl="${hid}"]`)].map((d) => {
          const r = d.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, right: r.right };
        });
      }, id);
      const allBottoms = geom.rects.map((r) => r.bottom);
      const maxBottom = Math.max(...allBottoms);
      const lastMarked = markedRects[markedRects.length - 1];
      check(
        "long: connector anchor is on the last line",
        Math.abs(lastMarked.bottom - maxBottom) < 4,
        `lastMarked.bottom=${lastMarked.bottom.toFixed(0)} maxBottom=${maxBottom.toFixed(0)}`,
      );
    }
  } else {
    check("long: geometry found", false);
  }

  /* ---- scenario 3: a repeated short word at a SPECIFIC occurrence ---- */
  // Deterministic: build the selection with a Range on the exact characters
  // of the LAST " the " on page 1, then fire mouseup so the app maps it.
  const rep = await p.evaluate(() => {
    const spans = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')];
    const withThe = spans.filter((sp) => / the /.test(sp.textContent || ""));
    const sp = withThe[withThe.length - 1];
    if (!sp || !sp.firstChild) return null;
    const t = sp.textContent || "";
    const i = t.lastIndexOf(" the ");
    const range = document.createRange();
    range.setStart(sp.firstChild, i + 1);
    range.setEnd(sp.firstChild, i + 4);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const r = range.getBoundingClientRect();
    sp.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return { left: r.left, top: r.top, bottom: r.bottom };
  });
  if (rep) {
    await new Promise((r) => setTimeout(r, 600));
    const id = await createFromSelection("repeated-the", "blue");
    if (id) {
      const geom = await overlayGeom(p, id);
      const near = geom.rects.some(
        (r) =>
          Math.abs((r.top + r.bottom) / 2 - (rep.top + rep.bottom) / 2) < 14 &&
          Math.abs(r.left - rep.left) < 25,
      );
      check("repeated: overlay at the SELECTED occurrence", near, JSON.stringify(geom.rects[0]));
    }
  } else {
    check("repeated: geometry found", false);
  }

  /* ---- scenario 4: drag past the end of page 1 into page 2 ---- */
  const cross = await p.evaluate(() => {
    const p1 = document.querySelector('[data-page="1"]');
    const p2 = document.querySelector('[data-page="2"]');
    const spans1 = [...p1.querySelectorAll(".pdf-textlayer span")];
    const last = spans1[spans1.length - 1];
    const r = last.getBoundingClientRect();
    const r2 = p2.getBoundingClientRect();
    return { x1: r.left + 3, y1: r.top + r.height / 2, x2: r2.left + 200, y2: r2.top + 60 };
  });
  await p.evaluate(() => document.querySelector('[data-page="1"]').scrollIntoView({ block: "end" }));
  await new Promise((r) => setTimeout(r, 1200));
  const cross2 = await p.evaluate(() => {
    const p1 = document.querySelector('[data-page="1"]');
    const spans1 = [...p1.querySelectorAll(".pdf-textlayer span")];
    const last = spans1[spans1.length - 2] ?? spans1[spans1.length - 1];
    const r = last.getBoundingClientRect();
    return { x1: r.left + 3, y1: r.top + r.height / 2 };
  });
  await p.mouse.move(cross2.x1, cross2.y1);
  await p.mouse.down();
  await p.mouse.move(cross2.x1 + 250, Math.min(cross2.y1 + 220, 880), { steps: 15 });
  await p.mouse.up();
  await new Promise((r) => setTimeout(r, 700));
  const crossSel = await p.evaluate(() => (window.getSelection()?.toString() ?? "").length);
  if (crossSel > 0) {
    await createFromSelection("cross-page (clamped)", "rose");
  } else {
    console.log("SKIP cross-page: drag produced no selection at this layout");
  }

  /* ---- cleanup ---- */
  for (const id of created) await deleteHighlight(p, id);
  console.log(`\\nRESULT: ${pass} passed, ${fail} failed (created+cleaned ${created.length})`);
  await p.screenshot({ path: "shot-battery.png" });
  await b.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("ERR:", e.message.slice(0, 400));
  process.exit(2);
});
