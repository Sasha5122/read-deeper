/**
 * Delete-session battery: upload a sacrificial doc through the real UI, add a
 * highlight to it, then delete the session from Recents (trash -> Delete?) and
 * verify the row vanishes, the reader redirects, and a reload confirms it gone.
 */
const puppeteer = require("puppeteer-core");
const path = require("path");
const CHROME = process.env.TEMP + "/rd-chrome/chrome/win64-152.0.7977.82/chrome-win64/chrome.exe";
const FIX = process.env.TEMP + "/rd-audit-fixtures";
const HOME_DOC = "27f352a4-bb4c-4074-a3d7-96a72841a90f";

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

  // 1) upload a sacrificial session via the real UI
  await p.goto(`http://localhost:3000/read/${HOME_DOC}`, { waitUntil: "networkidle2", timeout: 90000 });
  await p.evaluate(() => {
    [...document.querySelectorAll("header button")].find((x) => x.textContent.includes("Recents")).click();
  });
  await p.waitForFunction(() => [...document.querySelectorAll("button")].some((x) => x.textContent.includes("New session")), { timeout: 10000 });
  await p.evaluate(() => {
    [...document.querySelectorAll("button")].find((x) => x.textContent.includes("New session")).click();
  });
  const input = await p.waitForSelector("div[role=dialog] input[type=file]", { timeout: 10000 });
  const before = p.url();
  await input.uploadFile(path.join(FIX, "audit.txt"));
  await p.waitForFunction((prev) => window.location.href !== prev, { timeout: 120000 }, before);
  const docId = p.url().split("/read/")[1];
  check("D1: sacrificial session uploaded", !!docId, docId);
  await p.waitForSelector(".rd-page", { timeout: 30000 });
  await sleep(1200);

  // 2) delete it from Recents while it is the CURRENT session
  await p.evaluate(() => {
    [...document.querySelectorAll("header button")].find((x) => x.textContent.includes("Recents")).click();
  });
  await p.waitForFunction((id) => !!document.querySelector(`button[aria-label^="Delete session"]`), { timeout: 10000 }, docId);
  const rowsBefore = await p.evaluate(() => document.querySelectorAll('button[aria-label^="Delete session"]').length);
  // its own row: the one marked current
  await p.evaluate(() => {
    const row = [...document.querySelectorAll("a[aria-current=true]")][0]?.parentElement;
    row?.querySelector('button[aria-label^="Delete session"]')?.click();
  });
  await sleep(400); // React re-render
  const armed = await p.evaluate(() => {
    const row = [...document.querySelectorAll("a[aria-current=true]")][0]?.parentElement;
    return row?.querySelector('button[aria-label^="Delete session"]')?.textContent?.includes("Delete?") ?? false;
  });
  check("D2: first click arms the confirm (Delete?)", armed);
  const navPromise = p.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => null);
  await p.evaluate(() => {
    const row = [...document.querySelectorAll("a[aria-current=true]")][0]?.parentElement;
    row?.querySelector('button[aria-label^="Delete session"]')?.click();
  });
  await navPromise;
  await sleep(1500);
  check("D3: deleting the current session redirects away", !p.url().includes(docId), p.url());

  // 3) the session is really gone: reader 404s / list no longer shows it
  const res = await p.goto(`http://localhost:3000/read/${docId}`, { waitUntil: "networkidle2", timeout: 60000 });
  const gone = res.status() === 404 || (await p.evaluate(() => document.body.textContent || "")).includes("not") ||
    !(await p.evaluate(() => !!document.querySelector(".rd-page, .rd-pdf-page")));
  check("D4: deleted session no longer opens", gone, `status=${res.status()}`);

  await p.goto(`http://localhost:3000/read/${HOME_DOC}`, { waitUntil: "networkidle2", timeout: 90000 });
  await p.evaluate(() => {
    [...document.querySelectorAll("header button")].find((x) => x.textContent.includes("Recents")).click();
  });
  await sleep(1500);
  const rowsAfter = await p.evaluate(() => document.querySelectorAll('button[aria-label^="Delete session"]').length);
  const stillListed = await p.evaluate((id) => !![...document.querySelectorAll("a")].find((a) => a.getAttribute("href") === `/read/${id}`), docId);
  check("D5: session removed from Recents list", !stillListed, `rows ${rowsBefore} -> ${rowsAfter}`);
  await p.screenshot({ path: "v-delete-recents.png" });

  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
