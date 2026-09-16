/**
 * Entry-flow battery: "/" must open the reader directly on the LAST-OPENED
 * document (ChatGPT-style); /library and /documents are gone (redirect home);
 * navigation lives in the Recents menu.
 */
const puppeteer = require("puppeteer-core");
const CHROME = process.env.TEMP + "/rd-chrome/chrome/win64-152.0.7977.82/chrome-win64/chrome.exe";
const ZEBRA = "75a00f21-7549-490f-85e4-39cc703c7f48";
const YAWNS = "5a73bb68-23ad-4c65-86f5-8bfbccff9fc8";

let pass = 0, fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log("PASS", name, extra); }
  else { fail++; console.log("FAIL", name, extra); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage();
  await p.setViewport({ width: 1920, height: 950 });

  // seed "last opened" = dog-yawns by visiting it
  await p.goto(`http://localhost:3000/read/${YAWNS}`, { waitUntil: "networkidle2", timeout: 90000 });
  await p.waitForSelector(".rd-pdf-page canvas, .rd-page", { timeout: 30000 });
  await sleep(1000);

  // E1: "/" -> straight into the reader on the last-opened doc
  await p.goto("http://localhost:3000/", { waitUntil: "networkidle2", timeout: 90000 });
  check("E1: '/' lands in the reader", p.url().includes("/read/"), p.url());
  check("E1: on the LAST-OPENED doc (yawns)", p.url().includes(YAWNS));
  await p.waitForSelector(".rd-pdf-page canvas, .rd-page", { timeout: 30000 });
  check("E1: document rendered", true);

  // E2: open zebra, then "/" again -> zebra is now the last-opened
  await p.goto(`http://localhost:3000/read/${ZEBRA}`, { waitUntil: "networkidle2", timeout: 90000 });
  await p.waitForSelector(".rd-pdf-page canvas", { timeout: 30000 });
  await sleep(800);
  await p.goto("http://localhost:3000/", { waitUntil: "networkidle2", timeout: 90000 });
  check("E2: last-opened updated to zebra", p.url().includes(ZEBRA), p.url());

  // E3: old routes are gone -> both end up in the reader
  await p.goto("http://localhost:3000/library", { waitUntil: "networkidle2", timeout: 90000 });
  check("E3: /library redirects into the reader", p.url().includes("/read/"), p.url());
  await p.goto("http://localhost:3000/documents", { waitUntil: "networkidle2", timeout: 90000 });
  check("E3: /documents redirects into the reader", p.url().includes("/read/"), p.url());

  // E4: navigation via Recents still works (sessions listed + New session)
  await p.evaluate(() => {
    [...document.querySelectorAll("header button")].find((x) => x.textContent.includes("Recents"))?.click();
  });
  await sleep(1500);
  const recents = await p.evaluate(() => ({
    newSession: [...document.querySelectorAll("button")].some((x) => x.textContent.includes("New session")),
    rows: document.querySelectorAll('button[aria-label^="Delete session"]').length,
  }));
  check("E4: Recents opens with New session", recents.newSession);
  check("E4: sessions listed (incl. kept library books)", recents.rows >= 3, `${recents.rows} rows`);
  await p.screenshot({ path: "v-entry-recents.png" });

  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
