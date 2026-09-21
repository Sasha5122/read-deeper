/**
 * UX suite for the 2026-09-21 batch (local, DEV_AUTOLOGIN):
 * animated thinking · stop button (+partial persists) · paced streaming
 * (measured chars/s) · pdf links · AI-search result persistence ·
 * upload progress · size limit · ghost sessions in Recents.
 */
const playwright = require("playwright");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { createClient } = require("@supabase/supabase-js");

const BASE = process.env.RD_BASE ?? "http://localhost:3000";
const ZEBRA = "8d030271-2e23-4a9b-bfb1-5e8802b70839"; // local doc with DOI links (re-seeded 2026-09-21)
const FIX = process.env.TEMP + "/rd-audit-fixtures";
// local supabase demo service key (public demo value, local stack only)
const LOCAL_SERVICE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

let pass = 0, fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log("PASS", name, extra); }
  else { fail++; console.log("FAIL", name, extra); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeHighlightAndAsk(p, question) {
  const geo = await p.evaluate(() => {
    const spans = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')];
    const s = spans.find((x) => (x.textContent || "").trim().length > 40 && x.getBoundingClientRect().top > 150);
    const r = s.getBoundingClientRect();
    return { x1: r.left + 2, y1: r.top + r.height / 2, x2: r.left + r.width * 0.6, y2: r.top + r.height / 2 };
  });
  await p.mouse.move(geo.x1, geo.y1);
  await p.mouse.down();
  await p.mouse.move(geo.x2, geo.y2, { steps: 10 });
  await p.mouse.up();
  await sleep(800);
  await p.evaluate(() => document.querySelector('div[role=toolbar] button[aria-label*="blue"]').click());
  await sleep(1800);
  const hlId = await p.evaluate(() =>
    document.querySelector("[data-card] textarea")?.closest("[data-card]")?.getAttribute("data-card"));
  await p.fill("[data-card] textarea", question);
  await p.press("[data-card] textarea", "Enter");
  return hlId;
}
const cardLen = (p) => p.evaluate(() => {
  const c = document.querySelector("[data-card] textarea")?.closest("[data-card]");
  return c ? (c.textContent || "").length : 0;
});

(async () => {
  const b = await playwright.chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1920, height: 950 } })).newPage();
  const hlIds = [];

  await p.goto(`${BASE}/read/${ZEBRA}`, { waitUntil: "networkidle", timeout: 90000 });
  await p.waitForSelector(".rd-pdf-page canvas", { timeout: 45000 });
  await sleep(3000);

  /* ---------- 1. PDF links ---------- */
  const links = await p.evaluate(() => {
    const as = [...document.querySelectorAll('a[data-testid="pdf-link"]')];
    return {
      total: as.length,
      external: as.filter((a) => a.target === "_blank" && /^https?:/.test(a.href)).length,
      sample: as.find((a) => a.target === "_blank")?.href ?? "",
    };
  });
  check("L1: pdf link annotations rendered", links.total > 0, `${links.total} links`);
  check("L1: external links open in new tab", links.external > 0, links.sample.slice(0, 60));
  const selWorks = await p.evaluate(() => {
    // text selection must still work over the page despite the link layer
    const span = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')].find(
      (x) => (x.textContent || "").trim().length > 20);
    return !!span;
  });
  check("L2: text layer still reachable", selWorks);

  /* ---------- 2. thinking indicator (animated) + pacing ---------- */
  const hl1 = await makeHighlightAndAsk(p, "Explica pe larg, in detaliu, intreg experimentul si toate rezultatele.");
  hlIds.push(hl1);
  // catch the thinking indicator before first token
  let think = null;
  for (let i = 0; i < 100; i++) {
    think = await p.evaluate(() => {
      const el = document.querySelector('[data-testid="thinking-indicator"]');
      if (!el) return null;
      const w = el.querySelector(".rd-thinking-word");
      const d = el.querySelector(".rd-thinking-dot");
      return {
        word: w ? getComputedStyle(w).animationName : "",
        dot: d ? getComputedStyle(d).animationName : "",
      };
    });
    if (think) break;
    await sleep(100);
  }
  check("T1: thinking indicator mounts", !!think);
  check("T1: word shimmer animated", !!think && think.word !== "none" && think.word !== "", think?.word ?? "");
  check("T1: dots animated", !!think && think.dot !== "none" && think.dot !== "", think?.dot ?? "");

  // wait for first token, then sample growth for 6s
  const base1 = await cardLen(p);
  let started = false;
  for (let i = 0; i < 240; i++) {
    if ((await cardLen(p)) > base1 + 5) { started = true; break; }
    await sleep(500);
  }
  check("P1: stream starts", started);
  const samples = [];
  let prev = await cardLen(p);
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    const now = await cardLen(p);
    samples.push(now - prev);
    prev = now;
  }
  const grew = samples.reduce((a, x) => a + x, 0);
  const secs = (Date.now() - t0) / 1000;
  const cps = grew / secs;
  const maxJump = Math.max(...samples);
  // paced: sustained rate in a humane band (live 75-150 cps + bounded end-drain),
  // and above all NO burst floods — smoothness is the point.
  check("P2: paced rate 20-220 chars/s", cps >= 20 && cps <= 220, `${cps.toFixed(0)} cps over ${secs.toFixed(1)}s`);
  // per-tick cap lives in the pacer; 320 allows sampling jitter on the 4x end-drain
  check("P2: no burst floods (max 500ms jump <= 320 chars)", maxJump <= 320, `max jump ${maxJump}`);

  /* ---------- 3. stop button ---------- */
  const stopVisible = await p.evaluate(() => !!document.querySelector('button[aria-label="Stop generating"]'));
  check("S1: stop button visible while generating", stopVisible);
  const lenAtStop = await cardLen(p);
  await p.click('button[aria-label="Stop generating"]');
  await sleep(2500);
  const lenAfterStop = await cardLen(p);
  await sleep(2500);
  const lenLater = await cardLen(p);
  check("S2: generation stops (text growth halts)", lenLater - lenAfterStop <= 5, `+${lenLater - lenAfterStop} after stop`);
  check("S2: partial text kept (flushed)", lenAfterStop >= lenAtStop, `${lenAtStop} -> ${lenAfterStop}`);
  check("S2: no stuck thinking indicator", await p.evaluate(() => !document.querySelector('[data-testid="thinking-indicator"]')));
  check("S3: stop button gone, can ask again", await p.evaluate(() =>
    !document.querySelector('button[aria-label="Stop generating"]') && !!document.querySelector("[data-card] textarea")));
  // partial persists across reload (server saved it)
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForSelector(".rd-pdf-page canvas", { timeout: 45000 });
  await sleep(2500);
  await p.evaluate((id) => {
    const d = document.querySelector(`.pdf-overlay[data-owner="${id}"]`);
    const r = d.getBoundingClientRect();
    document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
  }, hl1);
  await sleep(1500);
  const persisted = await cardLen(p);
  check("S4: partial answer persisted after reload", persisted > 200, `${persisted} chars in card`);

  /* ---------- 4. AI search persistence ---------- */
  await p.keyboard.press("Escape");
  await sleep(400);
  await p.evaluate(() => {
    [...document.querySelectorAll("header button")].find((x) => x.textContent.includes("AI search")).click();
  });
  await sleep(600);
  const dlgInput = await p.waitForSelector('div[role=dialog] textarea, div[role=dialog] input[type=text]', { timeout: 8000 });
  await dlgInput.fill("Unde se descriu rezultatele principale?");
  await p.evaluate(() => {
    const dlg = document.querySelector("div[role=dialog]");
    [...dlg.querySelectorAll("button")].find((x) => /find|search|cauta/i.test(x.textContent))?.click();
  });
  // wait for a jump button (p. N)
  let jumps = 0;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    jumps = await p.evaluate(() => {
      const dlg = document.querySelector("div[role=dialog]");
      return dlg ? [...dlg.querySelectorAll("button")].filter((x) => /^p\.\s*\d+/.test(x.textContent.trim())).length : 0;
    });
    if (jumps > 0) break;
  }
  check("A1: AI search returns jump buttons", jumps > 0, `${jumps} jumps`);
  await p.evaluate(() => {
    const dlg = document.querySelector("div[role=dialog]");
    [...dlg.querySelectorAll("button")].find((x) => /^p\.\s*\d+/.test(x.textContent.trim()))?.click();
  });
  await sleep(1200);
  check("A2: dialog closed after jump", await p.evaluate(() => !document.querySelector('[data-testid="aisearch-cached-result"], div[role=dialog] textarea')));
  await p.evaluate(() => {
    [...document.querySelectorAll("header button")].find((x) => x.textContent.includes("AI search")).click();
  });
  await sleep(800);
  const cached = await p.evaluate(() => {
    const el = document.querySelector('[data-testid="aisearch-cached-result"]');
    const dlg = document.querySelector("div[role=dialog]");
    const jumps = dlg ? [...dlg.querySelectorAll("button")].filter((x) => /^p\.\s*\d+/.test(x.textContent.trim())).length : 0;
    return { restored: !!el, len: el ? el.textContent.length : 0, jumps };
  });
  check("A3: result restored on reopen", cached.restored, `${cached.len} chars`);
  check("A3: jump buttons restored", cached.jumps > 0, `${cached.jumps} jumps`);
  await p.keyboard.press("Escape");

  /* ---------- 4b. undo delete ---------- */
  // plain highlight (no AI): drag-select + blue
  const geoU = await p.evaluate(() => {
    const spans = [...document.querySelectorAll('[data-page="1"] .pdf-textlayer span')];
    const s = spans.filter((x) => (x.textContent || "").trim().length > 40 && x.getBoundingClientRect().top > 150)[1];
    const r = s.getBoundingClientRect();
    return { x1: r.left + 2, y1: r.top + r.height / 2, x2: r.left + r.width * 0.5, y2: r.top + r.height / 2 };
  });
  await p.mouse.move(geoU.x1, geoU.y1);
  await p.mouse.down();
  await p.mouse.move(geoU.x2, geoU.y2, { steps: 10 });
  await p.mouse.up();
  await sleep(800);
  await p.evaluate(() => document.querySelector('div[role=toolbar] button[aria-label*="blue"]').click());
  await sleep(1800);
  const undoHl = await p.evaluate(() =>
    document.querySelector("[data-card] textarea")?.closest("[data-card]")?.getAttribute("data-card"));
  check("D1: highlight for undo test created", !!undoHl, undoHl ?? "");
  await p.evaluate(() => document.querySelector('[data-card] button[aria-label="Delete highlight and thread"]')?.click());
  await sleep(600);
  check("D2: overlay disappears instantly", await p.evaluate((id) =>
    !document.querySelector(`.pdf-overlay[data-owner="${id}"]`), undoHl));
  check("D2: undo toast appears", await p.evaluate(() => {
    const t = document.querySelector('[data-testid="undo-toast"]');
    return !!t && /Conversation deleted/.test(t.textContent) && !!t.querySelector('button[aria-label="Undo delete"]');
  }));
  await p.click('button[aria-label="Undo delete"]');
  await sleep(800);
  check("D3: undo restores the highlight", await p.evaluate((id) =>
    !!document.querySelector(`.pdf-overlay[data-owner="${id}"]`), undoHl));
  check("D3: toast gone after undo", await p.evaluate(() => !document.querySelector('[data-testid="undo-toast"]')));
  // reopen its card, then delete for real and let the window elapse
  await p.evaluate((id) => {
    const d = document.querySelector(`.pdf-overlay[data-owner="${id}"]`);
    const r = d.getBoundingClientRect();
    document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
  }, undoHl);
  await sleep(900);
  check("D4: restored highlight reopens its chat", await p.evaluate(() => !!document.querySelector("[data-card] textarea")));
  await p.evaluate(() => document.querySelector('[data-card] button[aria-label="Delete highlight and thread"]')?.click());
  await sleep(7500); // past the 6s undo window — server delete fires
  check("D5: toast gone after window elapses", await p.evaluate(() => !document.querySelector('[data-testid="undo-toast"]')));
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForSelector(".rd-pdf-page canvas", { timeout: 45000 });
  await sleep(2500);
  check("D5: deletion is real after the window (survives reload)", await p.evaluate((id) =>
    !document.querySelector(`.pdf-overlay[data-owner="${id}"]`), undoHl));

  /* ---------- 5. upload progress + size limit (Recents dialog) ---------- */
  await p.evaluate(() => {
    [...document.querySelectorAll("header button")].find((x) => x.textContent.includes("Recents")).click();
  });
  await p.waitForFunction(() => [...document.querySelectorAll("button")].some((x) => x.textContent.includes("New session")), { timeout: 8000 });
  await p.evaluate(() => {
    [...document.querySelectorAll("button")].find((x) => x.textContent.includes("New session")).click();
  });
  const fileInput = await p.waitForSelector("div[role=dialog] input[type=file]", { timeout: 8000, state: "attached" });
  // watch for the progress element while uploading a real file — report into
  // Node via an exposed binding (window state dies on a hard navigation)
  let sawProgressNode = false;
  await p.exposeFunction("rdSawProgress", () => { sawProgressNode = true; });
  await p.evaluate(() => {
    const mo = new MutationObserver(() => {
      if (document.querySelector('[data-testid="upload-progress"]')) window.rdSawProgress();
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const urlBeforeUpload = p.url();
  await fileInput.setInputFiles(path.join(FIX, "audit.pdf"));
  // MUST wait for a *different* /read/ url — we're already on one (a bare
  // /\/read\// matcher resolves instantly and once cost us the zebra doc)
  await p.waitForURL((u) => u.pathname.startsWith("/read/") && u.href !== urlBeforeUpload, { timeout: 120000 });
  check("U1: upload progress element shown during upload", sawProgressNode);
  const uploadedId = p.url().split("/read/")[1];
  await p.waitForSelector(".rd-pdf-page canvas", { timeout: 45000 });
  await sleep(2500); // let the reader hydrate before reopening Recents

  // size limit: 26MB dummy refused instantly, no navigation
  const bigPath = path.join(os.tmpdir(), "rd-too-big.pdf");
  if (!fs.existsSync(bigPath)) fs.writeFileSync(bigPath, Buffer.alloc(26 * 1024 * 1024, 65));
  await p.evaluate(() => {
    [...document.querySelectorAll("header button")].find((x) => x.textContent.includes("Recents")).click();
  });
  await p.waitForFunction(() => [...document.querySelectorAll("button")].some((x) => x.textContent.includes("New session")), { timeout: 8000 });
  await p.evaluate(() => {
    [...document.querySelectorAll("button")].find((x) => x.textContent.includes("New session")).click();
  });
  const fi2 = await p.waitForSelector("div[role=dialog] input[type=file]", { timeout: 8000, state: "attached" });
  const urlBefore = p.url();
  await fi2.setInputFiles(bigPath);
  await sleep(2000);
  const sizeErr = await p.evaluate(() => {
    const scope = document.querySelector("div[role=dialog]") ?? document.body;
    const err = [...scope.querySelectorAll("p")].find((x) => /too large|Maximum/i.test(x.textContent));
    return err ? err.textContent : null;
  });
  check("U2: oversized file refused with clear message", !!sizeErr && /25 MB/.test(sizeErr), sizeErr ?? "no message");
  check("U2: no navigation happened", p.url() === urlBefore);
  await p.keyboard.press("Escape");

  /* ---------- 6. ghost sessions ---------- */
  const admin = createClient("http://127.0.0.1:54321", LOCAL_SERVICE, { auth: { persistSession: false } });
  // the ghosts must belong to the LOGGED-IN user (dev autologin), not an arbitrary row owner
  const { data: userList } = await admin.auth.admin.listUsers();
  const owner = userList.users.find((u) => u.email === "dev@local.test").id;
  const mk = async (status, ageMin) => {
    const { data, error } = await admin.from("documents").insert({
      owner_id: owner, title: `ghost-${status}-${ageMin}`, kind: "pdf", status, source: "upload",
      created_at: new Date(Date.now() - ageMin * 60000).toISOString(),
    }).select("id").single();
    if (error) throw new Error(error.message);
    return data.id;
  };
  const gFailed = await mk("failed", 5);
  const gStale = await mk("processing", 30);
  const gFresh = await mk("processing", 1);
  const recents = await p.evaluate(async () => (await fetch("/api/recents")).json());
  const ids = JSON.stringify(recents);
  check("G1: failed doc hidden from Recents", !ids.includes(gFailed));
  check("G2: stale processing (30min) hidden (flipped to failed)", !ids.includes(gStale));
  const { data: staleRow } = await admin.from("documents").select("status").eq("id", gStale).single();
  check("G2: stale row now status=failed in DB", staleRow.status === "failed", staleRow.status);
  check("G3: fresh processing still listed", ids.includes(gFresh));
  for (const id of [gFailed, gStale, gFresh]) await admin.from("documents").delete().eq("id", id);

  /* ---------- cleanup ---------- */
  const cleaned = await p.evaluate(async (ids) => {
    const out = [];
    for (const id of ids.filter(Boolean)) out.push((await fetch(`/api/highlights/${id}`, { method: "DELETE" })).ok);
    return out;
  }, hlIds);
  await p.evaluate(async (id) => (await fetch(`/api/documents/${id}`, { method: "DELETE" })).ok, uploadedId);
  console.log("cleanup:", JSON.stringify(cleaned));

  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
