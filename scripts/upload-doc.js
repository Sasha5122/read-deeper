/** Upload one file into Read Deeper through the real UI. Usage: node upload-doc.js <path> */
const puppeteer = require("puppeteer-core");
const CHROME = process.env.TEMP + "/rd-chrome/chrome/win64-152.0.7977.82/chrome-win64/chrome.exe";
const HOME_DOC = "27f352a4-bb4c-4074-a3d7-96a72841a90f";

(async () => {
  const file = process.argv[2];
  if (!file) { console.error("usage: node upload-doc.js <path>"); process.exit(2); }
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage();
  await p.setViewport({ width: 1920, height: 950 });
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
  await input.uploadFile(file);
  await p.waitForFunction((prev) => window.location.href !== prev, { timeout: 150000 }, before);
  const docId = p.url().split("/read/")[1];
  await p.waitForSelector(".rd-pdf-page canvas, .rd-page", { timeout: 45000 });
  console.log("uploaded:", docId);
  await b.close();
})();
