/** Final live smoke: real AI answer on the deployed app (test3 account). */
const puppeteer = require("puppeteer-core");
const path = require("path");
const CHROME = process.env.TEMP + "/rd-chrome/chrome/win64-152.0.7977.82/chrome-win64/chrome.exe";
const BASE = process.env.RD_BASE;
const FIX = process.env.TEMP + "/rd-audit-fixtures";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const ctx = await b.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 1600, height: 900 });
  await p.goto(`${BASE}/login`, { waitUntil: "networkidle2", timeout: 60000 });
  await p.type('input[type="email"]', "test3@readdeeper.app");
  await p.type('input[type="password"]', "Margine-Carte-93");
  await Promise.all([p.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => null), p.click('button[type="submit"]')]);
  await sleep(1500);

  const input = await p.waitForSelector('input[type="file"]', { timeout: 15000 });
  const before = p.url();
  await input.uploadFile(path.join(FIX, "audit.txt"));
  await p.waitForFunction((prev) => window.location.href !== prev && window.location.pathname.startsWith("/read/"), { timeout: 120000 }, before);
  const docId = p.url().split("/read/")[1];
  await p.waitForSelector(".rd-page", { timeout: 45000 });
  console.log("upload OK:", docId);
  await sleep(8000); // lasa AI prep sa termine (doc mic)

  // highlight prin drag pe un paragraf + amber
  const geo = await p.evaluate(() => {
    const t = [...document.querySelectorAll(".reading-column p")].find((x) => (x.textContent || "").length > 120);
    const range = document.createRange();
    range.selectNodeContents(t);
    const r = range.getClientRects()[0];
    return { x1: r.left + 2, y1: r.top + r.height / 2, x2: r.left + Math.min(r.width * 0.6, 400), y2: r.top + r.height / 2 };
  });
  await p.mouse.move(geo.x1, geo.y1); await p.mouse.down();
  await p.mouse.move(geo.x2, geo.y2, { steps: 10 }); await p.mouse.up();
  await sleep(800);
  await p.evaluate(() => document.querySelector('div[role=toolbar] button[aria-label*="amber"]')?.click());
  await sleep(2500);
  await p.evaluate(() => {
    const ta = document.querySelector("[data-card] textarea");
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    s.call(ta, "Explica pe scurt ce spune acest pasaj.");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await p.focus("[data-card] textarea");
  await p.keyboard.press("Enter");

  const base = await p.evaluate(() => (document.querySelector("[data-card] textarea")?.closest("[data-card]")?.textContent || "").length);
  let len = base, stable = 0;
  for (let i = 0; i < 90; i++) {
    await sleep(1500);
    const t = await p.evaluate(() => (document.querySelector("[data-card] textarea")?.closest("[data-card]")?.textContent || "").length);
    if (t > len + 5) { len = t; stable = 0; } else if (len > base + 150) { stable++; if (stable >= 3) break; }
  }
  const banner = await p.evaluate(() => document.querySelector("header .text-red-700")?.textContent ?? null);
  console.log(len > base + 150 && !banner ? `AI RASPUNDE PE LIVE: +${len - base} caractere, fara erori` : `PROBLEMA: +${len - base} chars, banner=${banner}`);

  await p.evaluate(async (id) => (await fetch(`/api/documents/${id}`, { method: "DELETE" })).ok, docId);
  console.log("curatat");
  await b.close();
})();
