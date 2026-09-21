import { describe, expect, it } from "vitest";
import {
  buildOffsets,
  extractPdfImagesBudgeted,
  fullTextOf,
  imageBudgetHasRoom,
  pageForOffset,
  paginate,
  PDF_IMAGE_BUDGET,
  type PdfImageParser,
} from "@/lib/extract";

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

describe("PDF image extraction budget", () => {
  /** Fake pdf-parse: one image of `imageBytes` per page, records pages asked. */
  function fakeParser(imageBytes: number, pagesAsked: number[]): PdfImageParser {
    return {
      async getImage({ partial, imageDataUrl }) {
        expect(imageDataUrl).toBe(false); // base64 copies are pure waste here
        pagesAsked.push(...partial);
        return {
          pages: partial.map((pageNumber) => ({
            pageNumber,
            images: [{ data: new Uint8Array(imageBytes) }],
          })),
        };
      },
    };
  }

  it("keeps every image of a normal document (well inside all budgets)", async () => {
    const asked: number[] = [];
    const byPage = await extractPdfImagesBudgeted(fakeParser(10_000, asked), 12);
    expect(asked).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(byPage.size).toBe(12);
    expect(byPage.get(3)?.[0].mime).toBe("image/png");
  });

  it("stops asking for pages once the image-count budget is spent", async () => {
    const asked: number[] = [];
    const byPage = await extractPdfImagesBudgeted(fakeParser(10, asked), 500);
    const total = [...byPage.values()].reduce((a, l) => a + l.length, 0);
    expect(total).toBe(PDF_IMAGE_BUDGET.maxImages);
    // early exit: pages past the budget are never parsed OR encoded
    expect(asked.length).toBe(PDF_IMAGE_BUDGET.maxImages);
    expect(Math.max(...asked)).toBeLessThanOrEqual(PDF_IMAGE_BUDGET.maxPages);
  });

  it("stops at the total-bytes budget on figure-heavy documents", async () => {
    const asked: number[] = [];
    const perImage = 5 * 1024 * 1024; // 5MB PNGs → byte cap hits before count cap
    const byPage = await extractPdfImagesBudgeted(fakeParser(perImage, asked), 55);
    const total = [...byPage.values()].reduce((a, l) => a + l.length, 0);
    const bytes = total * perImage;
    expect(bytes).toBeLessThan(PDF_IMAGE_BUDGET.maxTotalBytes + perImage);
    expect(total).toBeLessThan(PDF_IMAGE_BUDGET.maxImages);
    expect(asked.length).toBeLessThan(10); // early exit, not 55 pages of encoding
  });

  it("never scans pages beyond the per-document page cap", async () => {
    const asked: number[] = [];
    await extractPdfImagesBudgeted(
      {
        async getImage({ partial }) {
          asked.push(...partial);
          return { pages: partial.map((pageNumber) => ({ pageNumber, images: [] })) };
        },
      },
      500,
    );
    expect(asked.length).toBe(PDF_IMAGE_BUDGET.maxPages);
    expect(Math.max(...asked)).toBe(PDF_IMAGE_BUDGET.maxPages);
  });

  it("imageBudgetHasRoom is strict on both axes", () => {
    expect(imageBudgetHasRoom(0, 0)).toBe(true);
    expect(imageBudgetHasRoom(PDF_IMAGE_BUDGET.maxImages, 0)).toBe(false);
    expect(imageBudgetHasRoom(0, PDF_IMAGE_BUDGET.maxTotalBytes)).toBe(false);
  });
});
