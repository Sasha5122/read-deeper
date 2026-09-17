/**
 * Session longevity: after password login the auth cookies must be PERSISTENT
 * (far-future expiry, surviving browser restarts) â€” not session cookies.
 */
const puppeteer = require("puppeteer-core");
const CHROME = process.env.TEMP + "/rd-chrome/chrome/win64-152.0.7977.82/chrome-win64/chrome.exe";
const BASE = process.env.RD_BASE ?? "http://localhost:3000";

let pass = 0, fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log("PASS", name, extra); }
  else { fail++; console.log("FAIL", name, extra); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const ctx = await b.createBrowserContext();
  const p = await ctx.newPage();
  await p.goto(`${BASE}/login`, { waitUntil: "networkidle2", timeout: 60000 });
  await p.type('input[type="email"]', "test3@readdeeper.app");
  await p.type('input[type="password"]', "Margine-Carte-93");
  await Promise.all([
    p.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => null),
    p.click('button[type="submit"]'),
  ]);
  await sleep(2000);
  check("S1: logged in", !p.url().includes("/login"), p.url());

  const cookies = await p.cookies();
  const auth = cookies.filter((c) => c.name.startsWith("sb-"));
  check("S2: auth cookies present", auth.length > 0, `${auth.length} sb-* cookies`);
  const now = Date.now() / 1000;
  const days = auth.map((c) => (c.expires > 0 ? Math.round((c.expires - now) / 86400) : -1));
  const minDays = Math.min(...days);
  check("S3: cookies are PERSISTENT (not session)", auth.every((c) => c.expires > 0), `expiries(days)=${days.join(",")}`);
  check("S3: expiry >= 150 days", minDays >= 150, `min=${minDays} days`);

  // navigating around must not bounce to login
  await p.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 60000 });
  await p.goto(`${BASE}/settings`, { waitUntil: "networkidle2", timeout: 60000 });
  await p.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 60000 });
  check("S4: no re-login while navigating", !p.url().includes("/login"), p.url());

  await ctx.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
