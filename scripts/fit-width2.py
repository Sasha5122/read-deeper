import io

# ---- PdfView: fill the column (capped at 1100px for very wide monitors)
p = "components/reader/pdf/PdfView.tsx"
s = io.open(p, encoding="utf-8").read()
old = """  const baseWidth = 680;
  // Hard boundary: the page fills the text column but never crosses into chats.
  const width = Math.min(baseWidth, rootW > 0 ? rootW : baseWidth);"""
new = """  // Fit-to-width: the page fills the text column (never crossing into the
  // chat area), capped so lines stay readable on very wide monitors.
  const MAX_PAGE_WIDTH = 1100;
  const width = Math.min(rootW > 0 ? rootW : 680, MAX_PAGE_WIDTH);"""
assert old in s, "width formula"
s = s.replace(old, new)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)

# ---- audit battery: page must FILL the column
p = "scripts/test-reader-audit.js"
s = io.open(p, encoding="utf-8").read()
old = """  const a2cards = await p.evaluate(() => {"""
new = """  const fill = await p.evaluate(() => {
    const page = document.querySelector(".rd-pdf-page");
    const col = page.parentElement; // PdfView root fills the article column
    return { page: page.getBoundingClientRect().width, col: col.clientWidth };
  });
  check(
    "A2: page FILLS the column (fit-to-width)",
    fill.page >= Math.min(fill.col, 1100) * 0.95,
    `page=${fill.page.toFixed(0)} col=${fill.col.toFixed(0)}`,
  );
  const a2cards = await p.evaluate(() => {"""
assert old in s, "audit fill"
s = s.replace(old, new)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
