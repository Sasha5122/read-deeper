/**
 * LIVE journey in a REAL browser via Playwright (user-requested engine):
 * login → upload PDF → original pages render → highlight → real AI answer →
 * zoom + pan bar → reload persistence → cleanup. Full-viewport screenshots
 * at every step land in v-live-pw-*.png.
 *
 * Env: RD_BASE (default = live Cloud Run URL), RD_LOGIN_EMAIL, RD_LOGIN_PASS.
 */
const { chromium } = require("playwright");
const path = require("path");

const BASE = process.env.RD_BASE ?? "https://read-deeper-740826075015.europe-west1.run.app";
const EMAIL = process.env.RD_LOGIN_EMAIL ?? "test4@readdeeper.app";
const PASS = process.env.RD_LOGIN_PASS ?? "Pagina-Vie-64";
const FIX = process.env.TEMP + "/rd-audit-fixtures";

let pass = 0, fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log("PASS", name, extra); }
  else { fail++; console.log("FAIL", name, extra); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1920, height: 950 } });
  const p = await ctx.newPage();
  const consoleErrors = [];
  p.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  p.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  const shot = (n) => p.screenshot({ path: `v-live-pw-${n}.png` });

  /* 1 — login */
  await p.goto(BASE + "/", { waitUntil: "networkidle", timeout: 90000 });
  check("1: unauthenticated visit lands on /login", p.url().includes("/login"), p.url());
  await shot("1-login");
  await p.fill('input[type="email"]', EMAIL);
  await p.fill('input[type="password"]', PASS);
  await Promise.all([
    p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 90000 }),
    p.click('button[type="submit"]'),
  ]);
  await p.waitForLoadState("networkidle");
  check("2: login succeeds, leaves /login", !p.url().includes("/login"), p.url());

  /* 2 — upload a real PDF through the UI */
  let input = await p.$('input[type="file"]');
  if (!input) {
    await p.getByRole("button", { name: /Recents/ }).click();
    await p.getByRole("button", { name: /New session/ }).click();
    input = await p.waitForSelector('div[role=dialog] input[type=file]', { timeout: 10000 });
  }
  await input.setInputFiles(path.join(FIX, "audit.pdf"));
  await p.waitForURL(/\/read\//, { timeout: 150000 });
  const docId = p.url().split("/read/")[1];
  check("3: PDF upload navigates into the reader", !!docId, docId);
  await p.waitForSelector(".rd-pdf-page canvas", { timeout: 45000 });
  await sleep(3000);
  const canvases = await p.evaluate(() => document.querySelectorAll(".rd-pdf-page canvas").length);
  check("4: original PDF pages rendered", canvases >= 3, `${canvases} canvases`);
  const hasSentinel = await p.evaluate(() =>
    [...document.querySelectorAll(".pdf-textlayer")].some((l) => (l.textContent || "").includes("AUDITMARK-ONE")));
  check("5: page-1 text extracted (sentinel present)", hasSentinel);
  await shot("2-reader");

  /* 3 — highlight: drag-select a real sentence on page 1 */
  const geo = await p.evaluate(() => {
    const spans = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')];
    const s = spans.find((x) => (x.textContent || "").trim().length > 30 && x.getBoundingClientRect().top > 120);
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return { x1: r.left + 2, y1: r.top + r.height / 2, x2: r.left + r.width * 0.7, y2: r.top + r.height / 2 };
  });
  check("6: selectable sentence found on page 1", !!geo);
  await p.mouse.move(geo.x1, geo.y1);
  await p.mouse.down();
  await p.mouse.move(geo.x2, geo.y2, { steps: 12 });
  await p.mouse.up();
  await sleep(800);
  check("7: colour palette appears on selection", await p.evaluate(() => !!document.querySelector("[data-seltoolbar]")));
  await p.evaluate(() => document.querySelector('div[role=toolbar] button[aria-label*="amber"]').click());
  await sleep(2000);
  const hlId = await p.evaluate(() =>
    document.querySelector(".pdf-overlay[data-owner]")?.getAttribute("data-owner"));
  check("8: highlight created, chat card open", !!hlId && await p.evaluate(() => !!document.querySelector("[data-card] textarea")), hlId ?? "");
  await shot("3-highlight");

  /* 4 — real AI answer streamed on live */
  const aiBase = await p.evaluate(() => {
    const c = document.querySelector("[data-card] textarea")?.closest("[data-card]");
    return c ? (c.textContent || "").length : 0;
  });
  await p.fill("[data-card] textarea", "Explica simplu acest pasaj.");
  await p.press("[data-card] textarea", "Enter");
  let aiLen = aiBase;
  for (let i = 0; i < 120; i++) {
    await sleep(1500);
    const st = await p.evaluate(() => {
      const c = document.querySelector("[data-card] textarea")?.closest("[data-card]");
      return {
        len: c ? (c.textContent || "").length : 0,
        banner: document.querySelector("header .text-red-700")?.textContent?.trim() ?? null,
      };
    }).catch(() => ({ len: aiLen, banner: null }));
    if (st.banner) { aiLen = -1; break; }
    aiLen = st.len;
    if (aiLen > aiBase + 150) break;
  }
  check("9: real AI answer streamed, no error banner", aiLen > aiBase + 150, `+${aiLen - aiBase} chars`);
  await shot("4-ai-answer");

  /* 5 — zoom + pan bar */
  const w0 = await p.evaluate(() => document.querySelector('[data-page="1"]').getBoundingClientRect().width);
  await p.click('button[aria-label="Zoom in"]');
  await p.click('button[aria-label="Zoom in"]');
  await sleep(1500);
  const w1 = await p.evaluate(() => document.querySelector('[data-page="1"]').getBoundingClientRect().width);
  check("10: zoom in grows the page", w1 > w0 * 1.3, `${w0.toFixed(0)}px -> ${w1.toFixed(0)}px`);
  check("11: pan bar visible while zoomed", await p.evaluate(() => {
    const el = document.querySelector('[data-testid="zoom-panbar"]');
    return !!el && el.getBoundingClientRect().height > 0;
  }));
  await shot("5-zoom");
  await p.click('button[aria-label="Zoom out"]');
  await p.click('button[aria-label="Zoom out"]');
  await sleep(800);

  /* 6 — reload: session + highlight persist (no re-login) */
  await p.reload({ waitUntil: "networkidle" });
  check("12: reload keeps the session (no /login)", !p.url().includes("/login"), p.url());
  await p.waitForSelector(".rd-pdf-page canvas", { timeout: 45000 });
  await sleep(2500);
  check("13: highlight survives reload", await p.evaluate((id) =>
    !!document.querySelector(`.pdf-overlay[data-owner="${id}"]`), hlId));
  await shot("6-reload");

  /* 7 — cleanup: delete the uploaded doc */
  const del = await p.evaluate(async (id) =>
    (await fetch(`/api/documents/${id}`, { method: "DELETE" })).ok, docId);
  check("14: cleanup — uploaded doc deleted", del);

  const unexpected = consoleErrors.filter((e) => !/favicon|404/.test(e));
  check("15: no unexpected console errors", unexpected.length === 0, unexpected[0] ?? "");

  console.log(`\n${pass} passed, ${fail} failed  (base: ${BASE})`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
