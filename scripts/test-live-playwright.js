/**
 * LIVE journey in a REAL browser via Playwright (user-requested engine):
 * login → upload PDF → original pages render → highlight → real AI answer →
 * zoom + pan bar → reload persistence → cleanup. Full-viewport screenshots
 * at every step land in v-live-pw-*.png.
 *
 * Env: RD_BASE (default = live Cloud Run URL), RD_LOGIN_EMAIL, RD_LOGIN_PASS.
 */
const playwright = require("playwright");
const path = require("path");

/** RD_BROWSER: chromium (default) | firefox | webkit — same journey everywhere. */
const BROWSER = process.env.RD_BROWSER ?? "chromium";
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
  const b = await playwright[BROWSER].launch();
  const ctx = await b.newContext({ viewport: { width: 1920, height: 950 } });
  const p = await ctx.newPage();
  const consoleErrors = [];
  p.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  p.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  const shot = (n) => p.screenshot({ path: `v-live-pw-${BROWSER === "chromium" ? "" : BROWSER + "-"}${n}.png` });

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
    input = await p.waitForSelector('div[role=dialog] input[type=file]', { timeout: 10000, state: "attached" });
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

  /* 4 — real AI answer streamed on live (+ thinking indicator, stop button) */
  const aiBase = await p.evaluate(() => {
    const c = document.querySelector("[data-card] textarea")?.closest("[data-card]");
    return c ? (c.textContent || "").length : 0;
  });
  await p.fill("[data-card] textarea", "Explica simplu acest pasaj.");
  await p.press("[data-card] textarea", "Enter");
  // catch the animated thinking indicator before the first token
  let sawThinking = null;
  for (let i = 0; i < 80 && !sawThinking; i++) {
    sawThinking = await p.evaluate(() => {
      const el = document.querySelector('[data-testid="thinking-indicator"]');
      if (!el) return null;
      const w = el.querySelector(".rd-thinking-word");
      return { anim: w ? getComputedStyle(w).animationName : "" };
    });
    if (!sawThinking) await sleep(100);
  }
  check("9a: animated thinking indicator shows", !!sawThinking && sawThinking.anim !== "none", sawThinking?.anim ?? "not seen");
  let aiLen = aiBase;
  let sawStop = false;
  for (let i = 0; i < 120; i++) {
    await sleep(1500);
    const st = await p.evaluate(() => {
      const c = document.querySelector("[data-card] textarea")?.closest("[data-card]");
      return {
        len: c ? (c.textContent || "").length : 0,
        stop: !!document.querySelector('button[aria-label="Stop generating"]'),
        banner: document.querySelector("header .text-red-700")?.textContent?.trim() ?? null,
      };
    }).catch(() => ({ len: aiLen, stop: false, banner: null }));
    if (st.stop) sawStop = true;
    if (st.banner) { aiLen = -1; break; }
    aiLen = st.len;
    if (aiLen > aiBase + 150) break;
  }
  check("9: real AI answer streamed, no error banner", aiLen > aiBase + 150, `+${aiLen - aiBase} chars`);
  check("9b: stop button offered while generating", sawStop);
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

  /* 5b — capture: palette appears DIRECTLY, no verify modal, straight to chat */
  await p.keyboard.press("Escape");
  await sleep(500);
  await p.getByRole("button", { name: /Capture|Draw a box/ }).click();
  await p.waitForFunction(() =>
    [...document.querySelectorAll("div")].some((d) => d.classList.contains("rd-capture-cursor") && d.scrollHeight > d.clientHeight),
    { timeout: 8000 }).catch(() => {});
  await sleep(600);
  const pr = await p.evaluate(() => {
    const b = document.querySelector('[data-page="1"]').getBoundingClientRect();
    const top = Math.max(b.top, 60);
    return { left: b.left, top, width: b.width, height: Math.min(b.bottom, window.innerHeight - 10) - top };
  });
  await p.mouse.move(pr.left + pr.width * 0.2, pr.top + pr.height * 0.3);
  await p.mouse.down();
  await p.mouse.move(pr.left + pr.width * 0.55, pr.top + pr.height * 0.55, { steps: 10 });
  await p.mouse.up();
  await sleep(600);
  check("12: colour palette appears directly after framing",
    await p.evaluate(() => !!document.querySelector('button[aria-label^="Capture in"]')));
  await shot("5b-capture-palette");
  await p.click('button[aria-label="Capture in green"]');
  await sleep(3000);
  check("13: no verify modal — straight to chat",
    await p.evaluate(() => !document.querySelector('div[role=dialog][aria-label="Captured area"]')));
  check("14: region chat opens directly with input",
    await p.evaluate(() => !!document.querySelector("[data-card] textarea")));
  await shot("5c-capture-chat");
  await p.keyboard.press("Escape");
  await sleep(400);

  /* 6 — reload: session + highlight persist (no re-login) */
  await p.reload({ waitUntil: "networkidle" });
  check("15: reload keeps the session (no /login)", !p.url().includes("/login"), p.url());
  await p.waitForSelector(".rd-pdf-page canvas", { timeout: 45000 });
  await sleep(2500);
  check("16: highlight survives reload", await p.evaluate((id) =>
    !!document.querySelector(`.pdf-overlay[data-owner="${id}"]`), hlId));
  await shot("6-reload");

  /* 6b — EXTENDED (RD_EXTENDED=1, chromium runs): big PDF + links + progress */
  const extraIds = [];
  if (process.env.RD_EXTENDED === "1") {
    // big figure-heavy PDF (7.8MB/55p) — the exact class that used to hang live
    await p.getByRole("button", { name: /Recents/ }).click();
    await p.getByRole("button", { name: /New session/ }).click();
    let fi = await p.waitForSelector('div[role=dialog] input[type=file]', { timeout: 10000, state: "attached" });
    let sawProg = false;
    await p.exposeFunction("rdSawProg", () => { sawProg = true; });
    await p.evaluate(() => {
      const mo = new MutationObserver(() => {
        if (document.querySelector('[data-testid="upload-progress"]')) window.rdSawProg();
      });
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    let prevUrl = p.url();
    const tBig = Date.now();
    await fi.setInputFiles(process.env.TEMP + "/rd-bigpdf.pdf");
    await p.waitForURL((u) => u.pathname.startsWith("/read/") && u.href !== prevUrl, { timeout: 180000 });
    const bigSecs = (Date.now() - tBig) / 1000;
    const bigId = p.url().split("/read/")[1];
    extraIds.push(bigId);
    check("E1: 7.8MB/55p PDF uploads without hanging", true, `${bigSecs.toFixed(1)}s`);
    check("E1: well under the old hang (<120s)", bigSecs < 120, `${bigSecs.toFixed(1)}s`);
    check("E2: upload progress shown", sawProg);
    await p.waitForSelector(".rd-pdf-page canvas", { timeout: 60000 });
    await sleep(2500);
    const bigPages = await p.evaluate(() => {
      const m = /of (\d+)/.exec(document.querySelector("header").textContent || "");
      return m ? Number(m[1]) : 0;
    });
    check("E3: big PDF renders with all pages", bigPages >= 55, `${bigPages} pages`);
    await shot("7-bigpdf");

    // zebra (real PLOS article) — clickable link annotations on live
    await p.getByRole("button", { name: /Recents/ }).click();
    await p.getByRole("button", { name: /New session/ }).click();
    fi = await p.waitForSelector('div[role=dialog] input[type=file]', { timeout: 10000, state: "attached" });
    prevUrl = p.url();
    await fi.setInputFiles(process.env.TEMP + "/rd-bio/zebra.pdf");
    await p.waitForURL((u) => u.pathname.startsWith("/read/") && u.href !== prevUrl, { timeout: 180000 });
    const zebraId = p.url().split("/read/")[1];
    extraIds.push(zebraId);
    await p.waitForSelector(".rd-pdf-page canvas", { timeout: 60000 });
    await sleep(3000);
    const liveLinks = await p.evaluate(() => {
      const as = [...document.querySelectorAll('a[data-testid="pdf-link"]')];
      return { total: as.length, ext: as.filter((a) => a.target === "_blank" && /^https?:/.test(a.href)).length };
    });
    check("E4: pdf link annotations on live", liveLinks.total > 0, `${liveLinks.total} links`);
    check("E4: external links target new tab", liveLinks.ext > 0, `${liveLinks.ext} external`);
    await shot("8-links");
  }

  /* 7 — cleanup: delete the uploaded docs */
  const del = await p.evaluate(async (ids) => {
    const out = [];
    for (const id of ids) out.push((await fetch(`/api/documents/${id}`, { method: "DELETE" })).ok);
    return out.every(Boolean);
  }, [docId, ...extraIds]);
  check("17: cleanup — uploaded docs deleted", del);

  const unexpected = consoleErrors.filter((e) => !/favicon|404/.test(e));
  check("18: no unexpected console errors", unexpected.length === 0, unexpected[0] ?? "");

  console.log(`\n${pass} passed, ${fail} failed  (browser: ${BROWSER}, base: ${BASE})`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
