/**
 * Pre-deploy multi-user audit: password login works; users are ISOLATED
 * (cannot open or list each other's documents); per-user last-opened entry;
 * first-run landing for an empty account; wrong password rejected.
 */
const puppeteer = require("puppeteer-core");
const path = require("path");
const CHROME = process.env.TEMP + "/rd-chrome/chrome/win64-152.0.7977.82/chrome-win64/chrome.exe";
const BASE = process.env.RD_BASE ?? "http://localhost:3000";
const FIX = process.env.TEMP + "/rd-audit-fixtures";

let pass = 0, fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log("PASS", name, extra); }
  else { fail++; console.log("FAIL", name, extra); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(ctx, email, password) {
  const p = await ctx.newPage();
  await p.setViewport({ width: 1600, height: 900 });
  await p.goto(`${BASE}/login`, { waitUntil: "networkidle2", timeout: 60000 });
  await p.type('input[type="email"]', email);
  await p.type('input[type="password"]', password);
  await Promise.all([
    p.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => null),
    p.click('button[type="submit"]'),
  ]);
  await sleep(1500);
  return p;
}

async function uploadOwn(p, file) {
  // first-run landing has the UploadPanel with a file input
  const input = await p.waitForSelector('input[type="file"]', { timeout: 15000 });
  const before = p.url();
  await input.uploadFile(path.join(FIX, file));
  await p.waitForFunction((prev) => window.location.href !== prev && window.location.pathname.startsWith("/read/"),
    { timeout: 120000 }, before);
  await p.waitForSelector(".rd-pdf-page canvas, .rd-page", { timeout: 45000 });
  return p.url().split("/read/")[1];
}

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });

  /* ---- L1: wrong password rejected ---- */
  const ctx0 = await b.createBrowserContext();
  const p0 = await ctx0.newPage();
  await p0.goto(`${BASE}/login`, { waitUntil: "networkidle2", timeout: 60000 });
  await p0.type('input[type="email"]', "test1@readdeeper.app");
  await p0.type('input[type="password"]', "parola-gresita");
  await p0.click('button[type="submit"]');
  await sleep(2500);
  check("L1: wrong password shows error, stays on /login",
    p0.url().includes("/login") &&
    (await p0.evaluate(() => document.body.textContent.includes("Email sau"))));
  await ctx0.close();

  /* ---- A: test1 logs in, first-run landing, uploads a doc ---- */
  const ctxA = await b.createBrowserContext();
  const pA = await login(ctxA, "test1@readdeeper.app", "Zebra-Citeste-71");
  check("A1: password login lands in the app", !pA.url().includes("/login"), pA.url());
  const firstRunA = await pA.evaluate(() => !!document.querySelector('input[type="file"]'));
  check("A1: empty account sees the upload-first landing", firstRunA);
  const docA = await uploadOwn(pA, "audit.txt");
  check("A2: upload -> straight into the reader", !!docA, docA);
  await pA.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 60000 });
  check("A3: '/' returns to test1's last-opened doc", pA.url().includes(docA), pA.url());

  /* ---- B: test2 is fully isolated from test1 ---- */
  const ctxB = await b.createBrowserContext();
  const pB = await login(ctxB, "test2@readdeeper.app", "Somn-Adanc-82");
  check("B1: test2 login ok", !pB.url().includes("/login"));
  check("B1: test2's '/' does NOT leak test1's doc", !pB.url().includes(docA), pB.url());

  const resp = await pB.goto(`${BASE}/read/${docA}`, { waitUntil: "networkidle2", timeout: 60000 });
  check("B2: test1's document is a 404 for test2", resp.status() === 404, `status=${resp.status()}`);

  const recentsB = await pB.evaluate(async () => (await (await fetch("/api/recents")).json()));
  check("B2: test1's doc absent from test2's recents",
    !(recentsB.sessions ?? []).some((s) => s.documentId === docA),
    `${(recentsB.sessions ?? []).length} sessions listed`);

  await pB.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 60000 });
  const docB = await uploadOwn(pB, "audit.txt");
  check("B3: test2 uploads their own doc", !!docB && docB !== docA, docB);

  /* ---- A cannot see B ---- */
  const respA = await pA.goto(`${BASE}/read/${docB}`, { waitUntil: "networkidle2", timeout: 60000 });
  check("A4: test2's document is a 404 for test1", respA.status() === 404, `status=${respA.status()}`);

  /* ---- cross-delete must be refused ---- */
  const crossDel = await pB.evaluate(async (id) => (await fetch(`/api/documents/${id}`, { method: "DELETE" })).status, docA);
  check("B4: test2 CANNOT delete test1's doc", crossDel === 403 || crossDel === 404, `status=${crossDel}`);

  /* ---- cleanup: each user deletes their own doc ---- */
  await pA.goto(`${BASE}/read/${docA}`, { waitUntil: "networkidle2", timeout: 60000 });
  const delA = await pA.evaluate(async (id) => (await fetch(`/api/documents/${id}`, { method: "DELETE" })).ok, docA);
  const delB = await pB.evaluate(async (id) => (await fetch(`/api/documents/${id}`, { method: "DELETE" })).ok, docB);
  check("C1: cleanup (own deletes work)", delA && delB, JSON.stringify([delA, delB]));
  // cross-delete must FAIL (B deleting A's already-gone doc -> 404 anyway; test with fresh?)
  await ctxA.close(); await ctxB.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
