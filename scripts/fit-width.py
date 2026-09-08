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

# ---- Reader: in pdf mode the chat column is a fixed comfortable width and
# the document takes all remaining space; text mode keeps its 60/40 layout.
p = "components/reader/Reader.tsx"
s = io.open(p, encoding="utf-8").read()

old = """            <div ref={articleRef} className={isMobile ? "min-w-0 flex-1" : "w-[60%] min-w-0"}>"""
new = """            <div
              ref={articleRef}
              className={
                isMobile ? "min-w-0 flex-1" : pdfUrl ? "min-w-0 flex-1" : "w-[60%] min-w-0"
              }
            >"""
assert old in s, "article col"
s = s.replace(old, new)

old = """              <div ref={marginRef} className="relative z-20 w-[40%] shrink-0 self-stretch" data-margin-col>"""
alt = """              <div ref={marginRef} data-margin-col className="relative z-20 w-[40%] shrink-0 self-stretch">"""
if old not in s and alt not in s:
    # find the actual margin col line
    import re
    m = re.search(r'<div ref=\{marginRef\}[^>]*>', s)
    raise AssertionError("margin col not found: " + (m.group(0) if m else "none"))
target = old if old in s else alt
new = """              <div
                ref={marginRef}
                data-margin-col
                className={`relative z-20 shrink-0 self-stretch ${pdfUrl ? "w-[27.5rem]" : "w-[40%]"}`}
              >"""
s = s.replace(target, new)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)

# ---- audit battery: page must FILL the column (>=95% of min(column,1100))
p = "scripts/test-reader-audit.js"
s = io.open(p, encoding="utf-8").read()
old = """  const boundary = a2.marginLeft ?? a2.cardLeft;
  check(
    "A2: page never crosses into the chat column",
    boundary !== null && a2.pageRight <= boundary + 2,
    `pageRight=${a2.pageRight?.toFixed(0)} boundary=${boundary?.toFixed(0)}`,
  );"""
new = """  const boundary = a2.marginLeft ?? a2.cardLeft;
  check(
    "A2: page never crosses into the chat column",
    boundary !== null && a2.pageRight <= boundary + 2,
    `pageRight=${a2.pageRight?.toFixed(0)} boundary=${boundary?.toFixed(0)}`,
  );
  const fill = await p.evaluate(() => {
    const page = document.querySelector(".rd-pdf-page");
    const col = page.parentElement; // PdfView root fills the article column
    return { page: page.getBoundingClientRect().width, col: col.clientWidth };
  });
  check(
    "A2: page FILLS the column (fit-to-width)",
    fill.page >= Math.min(fill.col, 1100) * 0.95,
    `page=${fill.page.toFixed(0)} col=${fill.col.toFixed(0)}`,
  );"""
assert old in s, "audit fill"
s = s.replace(old, new)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
