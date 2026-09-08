// Dev utility: screenshot the reader + dump connector geometry.
const puppeteer = require("puppeteer-core");

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    args: ["--no-sandbox", "--window-size=1720,900"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1720, height: 900 });
  await page.goto("http://localhost:3000/read/96116c87-996d-4e40-b8bb-322ec927c278", {
    waitUntil: "networkidle2",
    timeout: 90000,
  });
  await page.waitForSelector("[data-hl]", { timeout: 20000 });
  await page.evaluate(() => {
    localStorage.clear();
    document.querySelector("[data-hl]").scrollIntoView({ block: "center" });
  });
  await new Promise((r) => setTimeout(r, 1200));
  const geo = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("[data-card]")].map((c) => {
      const r = c.getBoundingClientRect();
      return { id: c.getAttribute("data-card"), left: r.left, top: r.top, w: r.width };
    });
    const svg = document.querySelector("svg");
    const svgRect = svg ? svg.getBoundingClientRect() : null;
    const paths = svg
      ? [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d"))
      : [];
    return { svg: svgRect && { left: svgRect.left, top: svgRect.top, w: svgRect.width, h: svgRect.height }, cards, paths };
  });
  console.log(JSON.stringify(geo, null, 1));
  await page.screenshot({ path: "shot.png" });
  await browser.close();
})();
