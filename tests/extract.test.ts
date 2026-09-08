import { describe, expect, it } from "vitest";
import { buildOffsets, fullTextOf, pageForOffset, paginate } from "@/lib/extract";

describe("paginate + buildOffsets", () => {
  it("produces contiguous global offsets whose concatenation is the full text", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${"x".repeat(200)}`).join(
      "\n\n",
    );
    const pages = paginate(text, 1000);
    expect(pages.length).toBeGreaterThan(1);

    const rows = buildOffsets("doc", pages);
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i].char_end - rows[i].char_start).toBe(rows[i].text.length);
      if (i > 0) expect(rows[i].char_start).toBe(rows[i - 1].char_end);
    }

    const full = fullTextOf(rows);
    for (const row of rows) {
      expect(full.slice(row.char_start, row.char_end)).toBe(row.text);
    }
  });

  it("keeps paragraphs intact within pages", () => {
    const pages = paginate("first para\n\nsecond para\n\nthird para", 1000);
    expect(pages).toHaveLength(1);
    expect(pages[0].text).toContain("first para\n\nsecond para\n\nthird para");
  });

  it("maps offsets back to pages", () => {
    const rows = buildOffsets("doc", paginate("a".repeat(900) + "\n\n" + "b".repeat(900), 1000));
    expect(rows.length).toBe(2);
    expect(pageForOffset(rows, 10)?.page_no).toBe(1);
    expect(pageForOffset(rows, rows[1].char_start + 5)?.page_no).toBe(2);
  });
});
