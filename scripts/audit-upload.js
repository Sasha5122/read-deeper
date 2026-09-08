/**
 * AUDIT A — ingestion: every supported format uploaded through the REAL UI
 * (Recents → New session → file), then the reader is checked for the full
 * content: first-page sentinel, last-page sentinel, diacritics, page count.
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

const CASES = [
  // [file, expects pdf view?, probes]
  ["audit.pdf",  "pdf",    ["AUDITMARK-ONE", "AUDITMARK-LAST", "Cercetătorii", "Context window"]],
  ["audit.docx", "pdf",    ["AUDITMARK-ONE", "AUDITMARK-LAST", "Cercetătorii", "Context window"]],
  ["audit.doc",  "pdf",    []], // real-world sample, content unknown — just must open with pages
  ["audit.odt",  "pdf",    ["AUDITMARK-ONE", "AUDITMARK-LAST", "Cercetătorii"]],
  ["audit.rtf",  "pdf",    ["AUDITMARK-ONE", "AUDITMARK-LAST", "Cercetătorii"]],
  ["audit.epub", "reflow", ["AUDITMARK-ONE", "AUDITMARK-LAST", "Cercetătorii"]],
  ["audit.mobi", "reflow", ["Frankenstein"]],
  ["audit.txt",  "reflow", ["AUDITMARK-ONE", "AUDITMARK-LAST", "Cercetătorii"]],
  ["audit.md",   "reflow", ["AUDITMARK-ONE", "AUDITMARK-LAST", "Cercetătorii"]],
  ["audit.html", "reflow", ["AUDITMARK-ONE", "AUDITMARK-LAST", "Cercetătorii"]],
];

async function allText(p) {
  return await p.evaluate(() => {
    const layers = document.querySelectorAll(".pdf-textlayer, .reading-column, .rd-page");
    return [...layers].map((l) => l.textContent || "").join(" ");
  });
}

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage();
  await p.setViewport({ width: 1920, height: 950 });
  const consoleErrors = [];
  p.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  p.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });

  const uploadedIds = [];

  async function uploadViaUi(file) {
    await p.goto(`http://localhost:3000/read/${HOME_DOC}`, { waitUntil: "networkidle2", timeout: 90000 });
    // open Recents -> New session
    await p.evaluate(() => {
      const btn = [...document.querySelectorAll("header button")].find((x) => x.textContent.includes("Recents"));
      btn.click();
    });
    await p.waitForFunction(
      () => [...document.querySelectorAll("button")].some((x) => x.textContent.includes("New session")),
      { timeout: 10000 },
    );
    await p.evaluate(() => {
      [...document.querySelectorAll("button")].find((x) => x.textContent.includes("New session")).click();
    });
    const input = await p.waitForSelector('div[role=dialog] input[type=file]', { timeout: 10000 });
    const before = p.url();
    await input.uploadFile(path.join(FIX, file));
    // wait for either navigation to a new /read/ or an error paragraph
    try {
      await p.waitForFunction(
        (prev) => {
          if (window.location.href !== prev && window.location.pathname.startsWith("/read/")) return "nav";
          const dlg = document.querySelector("div[role=dialog]");
          const err = dlg && [...dlg.querySelectorAll("p")].find((x) => /fail|error|Supported|limit|could not/i.test(x.textContent));
          return err ? "err:" + err.textContent : false;
        },
        { timeout: 150000 },
        before,
      );
    } catch {
      return { ok: false, err: "timeout waiting for navigation/error" };
    }
    const outcome = await p.evaluate((prev) => {
      if (window.location.href !== prev) return "nav";
      const dlg = document.querySelector("div[role=dialog]");
      const err = dlg && [...dlg.querySelectorAll("p")].find((x) => /fail|error|Supported|limit|could not/i.test(x.textContent));
      return "err:" + (err ? err.textContent : "?");
    }, before);
    if (outcome !== "nav") return { ok: false, err: outcome };
    await p.waitForFunction(() => document.readyState === "complete", { timeout: 60000 });
    return { ok: true, id: p.url().split("/read/")[1] };
  }

  for (const [file, view, probes] of CASES) {
    console.log(`\n--- ${file} ---`);
    const errBase = consoleErrors.length;
    const res = await uploadViaUi(file);
    check(`${file}: upload + open`, res.ok, res.ok ? res.id : res.err);
    if (!res.ok) continue;
    uploadedIds.push(res.id);

    // content mounted?
    const sel = view === "pdf" ? ".rd-pdf-page canvas" : ".rd-page";
    try {
      await p.waitForSelector(sel, { timeout: 45000 });
    } catch {
      check(`${file}: ${view} view mounted`, false, `no ${sel}`);
      continue;
    }
    await new Promise((r) => setTimeout(r, 3000));
    check(`${file}: ${view} view mounted`, true);

    const pageCount = await p.evaluate(() => {
      const m = /of (\d+)/.exec(document.querySelector("header").textContent || "");
      return m ? Number(m[1]) : 0;
    });
    check(`${file}: has pages`, pageCount >= 1, `${pageCount} pages`);

    // scroll to the very bottom so all lazy content mounts, then probe
    await p.evaluate(async () => {
      const el = [...document.querySelectorAll("div")].find((d) => d.scrollHeight > d.clientHeight + 200 && d.clientHeight > 500);
      if (!el) return;
      for (let y = 0; y <= el.scrollHeight; y += 800) {
        el.scrollTop = y;
        await new Promise((r) => setTimeout(r, 60));
      }
      el.scrollTop = el.scrollHeight;
    });
    await new Promise((r) => setTimeout(r, 2500));
    const text = await allText(p);
    for (const probe of probes) {
      check(`${file}: contains "${probe}"`, text.includes(probe));
    }
    if (view === "pdf") {
      const canvases = await p.evaluate(() => document.querySelectorAll(".rd-pdf-page canvas").length);
      check(`${file}: original pages rendered`, canvases >= pageCount, `${canvases}/${pageCount} canvases`);
    }
    const newErrs = consoleErrors.slice(errBase).filter((e) => !/favicon|404/.test(e));
    check(`${file}: no console errors`, newErrs.length === 0, newErrs[0] ?? "");
    await p.screenshot({ path: `v-audit-${file.replace(".", "-")}.png` });
  }

  /* unsupported format is refused with a clear message, no navigation */
  console.log(`\n--- bad.xyz ---`);
  const bad = await uploadViaUi("bad.xyz");
  check("bad.xyz: refused with message", !bad.ok && /Supported/i.test(bad.err), bad.err);

  console.log(`\nUploaded doc ids: ${uploadedIds.join(", ")}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (consoleErrors.length) console.log("console errors seen:\n" + consoleErrors.slice(0, 20).join("\n"));
  await b.close();
  process.exit(fail ? 1 : 0);
})();
