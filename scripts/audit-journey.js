/**
 * AUDIT B — the reader's full journey on one document:
 * highlight → chat card → note → persistence → AI boundary → capture tool
 * (near + far page, verify window, persistence, delete) → search & paging.
 */
const puppeteer = require("puppeteer-core");
const CHROME = process.env.TEMP + "/rd-chrome/chrome/win64-152.0.7977.82/chrome-win64/chrome.exe";
const DOC = "27f352a4-bb4c-4074-a3d7-96a72841a90f";

let pass = 0, fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log("PASS", name, extra); }
  else { fail++; console.log("FAIL", name, extra); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scroller(p) {
  return await p.evaluateHandle(() =>
    [...document.querySelectorAll("div")].find((d) => d.scrollHeight > d.clientHeight + 200 && d.clientHeight > 500),
  );
}

async function hlIds(p) {
  return await p.evaluate(() =>
    [...new Set([...document.querySelectorAll(".pdf-overlay[data-owner]")].map((d) => d.getAttribute("data-owner")))],
  );
}

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage();
  await p.setViewport({ width: 1920, height: 950 });
  const consoleErrors = [];
  p.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  p.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push((m.text() + " @" + (m.location()?.url ?? "")).slice(0, 300));
  });

  async function open() {
    await p.goto(`http://localhost:3000/read/${DOC}`, { waitUntil: "networkidle2", timeout: 90000 });
    await p.waitForSelector(".rd-pdf-page canvas", { timeout: 30000 });
    await sleep(2800);
  }
  await open();
  await p.evaluate(() => localStorage.clear());

  /* ================= H — highlight -> chat ================= */
  const before = await hlIds(p);

  // H1: drag-select a sentence on page 1
  const geo = await p.evaluate(() => {
    const spans = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')];
    const s = spans.find((x) => (x.textContent || "").includes("Readers of contracts"));
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return { x1: r.left + 2, y1: r.top + r.height / 2, x2: r.left + r.width * 0.7, y2: r.top + r.height / 2 };
  });
  check("H1: target sentence found", !!geo);
  await p.mouse.move(geo.x1, geo.y1);
  await p.mouse.down();
  await p.mouse.move(geo.x2, geo.y2, { steps: 12 });
  await p.mouse.up();
  await sleep(700);
  check("H1: colour palette appears", await p.evaluate(() => !!document.querySelector("[data-seltoolbar]")));

  // H2: pick amber -> highlight + expanded card with textarea
  await p.evaluate(() => document.querySelector('div[role=toolbar] button[aria-label*="amber"]').click());
  await sleep(1800);
  const after = await hlIds(p);
  const newId = after.find((id) => !before.includes(id));
  check("H2: highlight overlay created", !!newId, newId ?? "");
  check("H2: chat card opened with input", await p.evaluate(() => !!document.querySelector("[data-card] textarea")));
  const cardPos = await p.evaluate(() => {
    const c = document.querySelector("[data-card] textarea")?.closest("[data-card]");
    const page = document.querySelector('[data-page="1"]');
    if (!c || !page) return null;
    return { cardLeft: c.getBoundingClientRect().left, pageRight: page.getBoundingClientRect().right };
  });
  check("H2: card sits in the right margin", !!cardPos && cardPos.cardLeft >= cardPos.pageRight - 4,
    cardPos ? `card.left=${cardPos.cardLeft.toFixed(0)} page.right=${cardPos.pageRight.toFixed(0)}` : "");

  // H3: Note saves without AI and shows up
  const NOTE = "Nota personala de audit — ramane fara AI";
  await p.evaluate((t) => {
    const ta = document.querySelector("[data-card] textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, t);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, NOTE);
  await p.evaluate(() => {
    [...document.querySelectorAll("[data-card] button")].find((x) => x.textContent.trim() === "Note").click();
  });
  await sleep(1200);
  check("H3: note appears in the thread", await p.evaluate((t) =>
    (document.querySelector("[data-card] textarea")?.closest("[data-card]")?.textContent || "").includes(t), NOTE));

  // H4: Esc collapses, clicking the highlight reopens
  await p.keyboard.press("Escape");
  await sleep(500);
  check("H4: Esc collapses the chat", await p.evaluate(() => !document.querySelector("[data-card] textarea")));
  await p.evaluate((id) => {
    const d = document.querySelector(`.pdf-overlay[data-owner="${id}"]`);
    const r = d.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  }, newId);
  await sleep(800);
  check("H4: clicking the highlight reopens its chat", await p.evaluate(() => !!document.querySelector("[data-card] textarea")));

  // H5: persistence across reload
  await open();
  check("H5: highlight survives reload", (await hlIds(p)).includes(newId));
  await p.evaluate((id) => {
    const d = document.querySelector(`.pdf-overlay[data-owner="${id}"]`);
    const r = d.getBoundingClientRect();
    document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
  }, newId);
  await sleep(1000);
  check("H5: note survives reload", await p.evaluate((t) =>
    (document.querySelector("[data-card] textarea")?.closest("[data-card]")?.textContent || "").includes(t), NOTE));

  /* ============ AI: Explain streams a real answer (key configured) ============ */
  const aiBase = await p.evaluate(() => {
    const card = document.querySelector("[data-card] textarea")?.closest("[data-card]");
    return card ? (card.textContent || "").length : 0;
  });
  // The starter buttons hide once the thread has messages (the note above),
  // so ask the way a real reader would: type + Enter.
  await p.evaluate(() => {
    const ta = document.querySelector("[data-card] textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, "Explain this passage simply.");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await p.focus("[data-card] textarea");
  await p.keyboard.press("Enter");
  let aiLen = aiBase;
  for (let i = 0; i < 120; i++) {
    await sleep(1500);
    const st = await p.evaluate(() => {
      const card = document.querySelector("[data-card] textarea")?.closest("[data-card]");
      return {
        len: card ? (card.textContent || "").length : 0,
        banner: document.querySelector("header .text-red-700")?.textContent?.trim() ?? null,
      };
    }).catch(() => ({ len: aiLen, banner: null }));
    if (st.banner) { aiLen = -1; break; }
    aiLen = st.len;
    if (aiLen > aiBase + 150) break;
  }
  check("AI: Explain streams a real answer, no error", aiLen > aiBase + 150, `+${aiLen - aiBase} chars`);

  // H6: delete removes highlight + card
  await p.evaluate(() => {
    document.querySelector('[data-card] button[aria-label="Delete highlight and thread"]')?.click();
  });
  await sleep(1500);
  check("H6: delete removes the highlight", !(await hlIds(p)).includes(newId));

  /* ================= C — capture tool ================= */
  async function activateCapture() {
    await p.evaluate(() => {
      [...document.querySelectorAll("header button")].find((x) => /Capture|Draw a box/.test(x.textContent)).click();
    });
    await p.waitForFunction(() => !![...document.querySelectorAll("div")].find((d) => d.classList.contains("rd-capture-cursor") && d.scrollHeight > d.clientHeight), { timeout: 5000 }).catch(() => {});
    await sleep(600);
  }
  async function drawRect(pageNo, fx0, fy0, fx1, fy1) {
    // fractions apply to the VISIBLE part of the page — mouse events cannot
    // land outside the viewport
    const r = await p.evaluate((n) => {
      const w = document.querySelector(`[data-page="${n}"]`);
      const b = w.getBoundingClientRect();
      const top = Math.max(b.top, 60);
      const bottom = Math.min(b.bottom, window.innerHeight - 10);
      return { left: b.left, top, width: b.width, height: bottom - top };
    }, pageNo);
    const x0 = r.left + r.width * fx0, y0 = r.top + r.height * fy0;
    const x1 = r.left + r.width * fx1, y1 = r.top + r.height * fy1;
    await p.mouse.move(x0, y0);
    await p.mouse.down();
    await p.mouse.move(x1, y1, { steps: 10 });
    await p.mouse.up();
    await sleep(500);
  }

  // C1: activate, cursor arms
  await activateCapture();
  check("C1: capture cursor active on the reading area",
    await p.evaluate(() => [...document.querySelectorAll("div")].some((d) => d.classList.contains("rd-capture-cursor") && d.scrollHeight > d.clientHeight)));

  // C2: frame an area over page-1 graphics -> palette appears DIRECTLY, cursor reverts
  await drawRect(1, 0.15, 0.72, 0.45, 0.88);
  check("C2: colour palette appears directly after framing",
    await p.evaluate(() => !!document.querySelector('button[aria-label^="Capture in"]')));
  check("C2: cursor reverts to arrow once framed",
    await p.evaluate(() => ![...document.querySelectorAll("div")].some((d) => d.classList.contains("rd-capture-cursor") && d.scrollHeight > d.clientHeight)));

  // C3: palette fully on screen
  const palBox = await p.evaluate(() => {
    const sw = document.querySelector('button[aria-label^="Capture in"]');
    const r = sw?.parentElement?.getBoundingClientRect();
    return r ? { left: r.left, right: r.right, w: window.innerWidth } : null;
  });
  check("C3: capture palette fully visible", !!palBox && palBox.left >= 0 && palBox.right <= palBox.w,
    palBox ? `left=${palBox.left.toFixed(0)} right=${palBox.right.toFixed(0)}` : "");

  // C4: pick green -> NO verify modal; straight to the region chat
  const regsBefore = await hlIds(p);
  await p.evaluate(() => document.querySelector('button[aria-label="Capture in green"]')?.click());
  await sleep(2500);
  check("C4: no verify modal — straight to chat",
    await p.evaluate(() => !document.querySelector('div[role=dialog][aria-label="Captured area"]')));
  check("C4: region chat opens directly with input",
    await p.evaluate(() => !!document.querySelector("[data-card] textarea")));
  await p.screenshot({ path: "v-audit-capture-direct.png" });
  const regsAfter = await hlIds(p);
  const regionId = regsAfter.find((id) => !regsBefore.includes(id));
  check("C4: coloured frame + chat created", !!regionId, regionId ?? "");

  // C5: capture works on a FAR page after scrolling (page 3)
  const sc = await scroller(p);
  await p.evaluate((el) => { el.scrollTop = el.scrollHeight; }, sc);
  await sleep(2500);
  await activateCapture();
  await drawRect(3, 0.2, 0.2, 0.5, 0.35);
  const regs2Before = await hlIds(p);
  await p.evaluate(() => document.querySelector('button[aria-label="Capture in rose"]')?.click());
  await sleep(2500);
  const regs2After = await hlIds(p);
  const regionId2 = regs2After.find((id) => !regs2Before.includes(id));
  check("C5: capture works on page 3 after scrolling", !!regionId2, regionId2 ?? "");
  const onPage3 = await p.evaluate((id) => {
    const d = document.querySelector(`.pdf-overlay[data-owner="${id}"]`);
    return !!d?.closest('[data-page="3"]');
  }, regionId2);
  check("C5: page-3 frame pinned to page 3", onPage3);

  // C6: both regions survive reload
  await open();
  const persisted = await hlIds(p);
  check("C6: page-1 region survives reload", persisted.includes(regionId));
  check("C6: page-3 region survives reload", persisted.includes(regionId2));
  await p.screenshot({ path: "v-audit-regions-reload.png" });

  // C7: delete both region threads (open card -> ✕), with a retry per region
  async function deleteRegion(rid) {
    if (!rid) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      // bring the region's centre into the middle of the viewport
      await p.evaluate((id) => {
        const d = document.querySelector(`.pdf-overlay[data-owner="${id}"]`);
        if (!d) return;
        const r = d.getBoundingClientRect();
        const sc = [...document.querySelectorAll("div")].find((x) => x.scrollHeight > x.clientHeight + 200 && x.clientHeight > 500);
        sc.scrollTop += r.top + r.height / 2 - window.innerHeight / 2;
      }, rid);
      await sleep(1400);
      await p.evaluate((id) => {
        const d = document.querySelector(`.pdf-overlay[data-owner="${id}"]`);
        if (!d) return;
        const r = d.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        document.elementFromPoint(cx, cy)
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: cx, clientY: cy }));
      }, rid);
      await sleep(900);
      const opened = await p.evaluate(() => !!document.querySelector("[data-card] textarea"));
      if (!opened) continue;
      await p.evaluate(() => {
        document.querySelector('[data-card] button[aria-label="Delete highlight and thread"]')?.click();
      });
      try {
        await p.waitForFunction(
          (id) => !document.querySelector(`.pdf-overlay[data-owner="${id}"]`),
          { timeout: 6000 },
          rid,
        );
        return true;
      } catch { /* retry */ }
    }
    return false;
  }
  check("C7: page-1 region deleted", await deleteRegion(regionId));
  check("C7: page-3 region deleted", await deleteRegion(regionId2));

  // C8: Esc abandons a framed capture
  await activateCapture();
  await drawRect(1, 0.55, 0.3, 0.7, 0.4);
  await p.keyboard.press("Escape");
  await sleep(400);
  check("C8: Esc abandons the framed rectangle",
    await p.evaluate(() => !document.querySelector('button[aria-label^="Capture in"]')));

  /* ================= S — search & paging ================= */
  await p.evaluate(() => { const i = document.querySelector('header input[placeholder="Search in text"]'); i.focus(); });
  await p.keyboard.type("comprehension");
  await sleep(1200);
  const hits = await p.evaluate(() => {
    const m = /(\d+)\/(\d+)/.exec(document.querySelector("header").textContent || "");
    return m ? Number(m[2]) : 0;
  });
  check("S1: classic search finds hits", hits > 0, `${hits} hits`);
  await p.keyboard.press("Enter");
  await sleep(1200);
  check("S1: current hit marked in text", await p.evaluate(() =>
    !!document.querySelector(".hl-search-current, .hl-search-current-marker")));
  await p.keyboard.press("Escape");

  const getScroll = () => p.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find((d) => d.scrollHeight > d.clientHeight + 200 && d.clientHeight > 500);
    return el ? el.scrollTop : 0;
  });
  const scBefore = await getScroll();
  await p.evaluate(() => { const i = document.querySelector('header input[aria-label="Go to page"]'); i.focus(); i.select(); });
  await p.keyboard.type("3");
  await p.keyboard.press("Enter");
  await sleep(1500);
  const scAfterGoto = await getScroll();
  check("S2: go-to-page 3 scrolls the reader", Math.abs(scAfterGoto - scBefore) > 300, `scrollTop ${scBefore.toFixed(0)} -> ${scAfterGoto.toFixed(0)}`);
  let indicator = "";
  try {
    await p.waitForFunction(
      () => document.querySelector('header input[aria-label="Go to page"]').value === "3",
      { timeout: 6000 },
    );
    indicator = "3";
  } catch {
    indicator = await p.evaluate(() => document.querySelector('header input[aria-label="Go to page"]').value);
  }
  check("S2: page indicator follows", indicator === "3", `indicator=${indicator}`);

  /* ================= console errors ================= */
  const unexpected = consoleErrors.filter(
    (e) => !/favicon|404|Failed to load resource.*40[13]|answer failed|stream|503|\/messages/i.test(e),
  );
  check("E1: no unexpected console errors across the journey", unexpected.length === 0,
    unexpected.slice(0, 3).join(" || "));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (consoleErrors.length) console.log("all console errors:\n" + consoleErrors.slice(0, 15).join("\n"));
  await b.close();
  process.exit(fail ? 1 : 0);
})();
