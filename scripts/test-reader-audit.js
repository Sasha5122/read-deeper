/** Audit battery: session-open cards, zoom cap, highlight click, far search. */
const puppeteer = require("puppeteer-core");
const CHROME = process.env.TEMP + "/rd-chrome/chrome/win64-152.0.7977.82/chrome-win64/chrome.exe";
const DOC = "37930491-b4e8-4fc8-acd4-6d51a7590f5b"; // real arXiv paper, 15 pages

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  ok ? pass++ : fail++;
  console.log(ok ? "PASS" : "FAIL", name, extra);
};

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage();
  await p.setViewport({ width: 1720, height: 900, deviceScaleFactor: 2 });
  const created = [];

  async function load() {
    await p.goto(`http://localhost:3000/read/${DOC}`, { waitUntil: "networkidle2", timeout: 90000 });
    await p.waitForSelector(".rd-pdf-page canvas", { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 3000));
  }

  await load();
  await p.evaluate(() => localStorage.clear());

  /* setup: make sure the session has at least one highlight */
  const existing = await p.evaluate(
    () => new Set([...document.querySelectorAll(".pdf-overlay[data-owner]")].map((d) => d.getAttribute("data-owner"))).size,
  );
  if (existing === 0) {
    const geo = await p.evaluate(() => {
      const s = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')].find(
        (x) => (x.textContent || "").length > 40,
      );
      const r = s.getBoundingClientRect();
      return { x1: r.left + 3, y: r.top + r.height / 2, x2: r.right - 5 };
    });
    await p.mouse.move(geo.x1, geo.y);
    await p.mouse.down();
    await p.mouse.move(geo.x2, geo.y, { steps: 10 });
    await p.mouse.up();
    await new Promise((r) => setTimeout(r, 700));
    await p.evaluate(() => document.querySelector('div[role=toolbar] button[aria-label*="amber"]')?.click());
    await new Promise((r) => setTimeout(r, 1600));
    const ids = await p.evaluate(() =>
      [...new Set([...document.querySelectorAll(".pdf-overlay[data-owner]")].map((d) => d.getAttribute("data-owner")))],
    );
    created.push(...ids);
    await p.keyboard.press("Escape");
  }

  /* ---- A1: open the session fresh — cards must be there WITHOUT any action */
  await load(); // full reload, no interactions
  const a1 = await p.evaluate(() => {
    const overlays = document.querySelectorAll(".pdf-overlay[data-owner]").length;
    const cards = [...document.querySelectorAll("[data-card]")];
    const visible = cards.filter((c) => {
      const st = getComputedStyle(c);
      return st.visibility !== "hidden" && c.getBoundingClientRect().width > 0;
    });
    const paths = document.querySelectorAll("svg path").length;
    return { overlays, cards: cards.length, visible: visible.length, paths };
  });
  check("A1: overlays painted on load", a1.overlays >= 1, `overlays=${a1.overlays}`);
  check("A1: chat cards VISIBLE on load (no action needed)", a1.visible >= 1, JSON.stringify(a1));
  check("A1: connector lines drawn on load", a1.paths >= 1, `paths=${a1.paths}`);

  /* ---- A2: the page must stop at the chat boundary */
  await new Promise((r) => setTimeout(r, 500));
  const a2 = await p.evaluate(() => {
    const page = document.querySelector(".rd-pdf-page");
    const pageR = page.getBoundingClientRect();
    const article = page.closest("div").parentElement; // article column div
    const card = document.querySelector("[data-card]");
    const cardR = card ? card.getBoundingClientRect() : null;
    const marginCol = document.querySelector("[data-margin-col]");
    const marginR = marginCol ? marginCol.getBoundingClientRect() : null;
    return {
      pageRight: pageR.right,
      cardLeft: cardR ? cardR.left : null,
      marginLeft: marginR ? marginR.left : null,
      zoomLabel: "n/a",
    };
  });
  const boundary = a2.marginLeft ?? a2.cardLeft;
  check(
    "A2: page never crosses into the chat column",
    boundary !== null && a2.pageRight <= boundary + 2,
    `pageRight=${a2.pageRight?.toFixed(0)} boundary=${boundary?.toFixed(0)}`,
  );
  const fill = await p.evaluate(() => {
    const page = document.querySelector(".rd-pdf-page");
    const col = page.parentElement; // PdfView root fills the article column
    return { page: page.getBoundingClientRect().width, col: col.clientWidth };
  });
  check(
    "A2: page FILLS the column (fit-to-width)",
    fill.page >= Math.min(fill.col, 1100) * 0.95,
    `page=${fill.page.toFixed(0)} col=${fill.col.toFixed(0)}`,
  );
  const a2cards = await p.evaluate(() => {
    const cards = [...document.querySelectorAll("[data-card]")];
    return cards.filter((c) => getComputedStyle(c).visibility !== "hidden" && c.getBoundingClientRect().width > 0).length;
  });
  check("A2: cards still visible", a2cards >= 1, `visible=${a2cards}`);

  /* ---- A3: clicking a highlight opens its thread card */
  const ov = await p.evaluate(() => {
    const d = document.querySelector('.pdf-overlay[data-owner]:not([data-owner^="s-"])');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: d.getAttribute("data-owner") };
  });
  if (ov) {
    // scroll it into view first
    await p.evaluate(() => {
      document.querySelector('.pdf-overlay[data-owner]')?.scrollIntoView({ block: "center" });
    });
    await new Promise((r) => setTimeout(r, 800));
    const ov2 = await p.evaluate(() => {
      const d = document.querySelector('.pdf-overlay[data-owner]');
      const r = d.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await p.mouse.click(ov2.x, ov2.y);
    await new Promise((r) => setTimeout(r, 900));
    const expanded = await p.evaluate(() => !!document.querySelector("[data-card] textarea"));
    check("A3: clicking the highlight opens its chat", expanded);
    await p.keyboard.press("Escape");
  } else {
    check("A3: overlay present for click test", false);
  }

  /* ---- A4: search hit on a far, unrendered page still centres the match */
  await p.type('input[placeholder="Search in text"]', "Gauthier");
  await new Promise((r) => setTimeout(r, 2600));
  const a4 = await p.evaluate(() => {
    const el = document.querySelector(".hl-search-current-marker, .hl-search-current");
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    return { found: true, inView: r.top > 40 && r.bottom < window.innerHeight, top: r.top };
  });
  check("A4: far-page search match painted", a4.found, JSON.stringify(a4));
  check("A4: match centred in view", a4.found && a4.inView, `top=${a4.top?.toFixed(0)}`);

  /* cleanup only what this run created */
  for (const id of created) {
    await p.evaluate(async (hid) => {
      await fetch(`/api/highlights/${hid}`, { method: "DELETE" });
    }, id);
  }
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await p.screenshot({ path: "shot-audit.png" });
  await b.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("ERR:", e.message.slice(0, 300));
  process.exit(2);
});
