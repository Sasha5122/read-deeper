import { describe, expect, it } from "vitest";
import { makeAnchor, resolveAnchor } from "@/lib/anchoring";

const TEXT =
  "The works of the great poets have never yet been read by mankind. " +
  "They have only been read as the multitude read the stars. " +
  "Books must be read as deliberately as they were written.";

describe("makeAnchor", () => {
  it("captures quote, prefix and suffix", () => {
    const start = TEXT.indexOf("read the stars");
    const anchor = makeAnchor(TEXT, start, start + "read the stars".length);
    expect(anchor.quote).toBe("read the stars");
    expect(anchor.prefix.endsWith("multitude ")).toBe(true);
    expect(anchor.suffix.startsWith(". Books")).toBe(true);
  });
});

describe("resolveAnchor", () => {
  it("uses stored offsets when they still match", () => {
    const start = TEXT.indexOf("great poets");
    const anchor = makeAnchor(TEXT, start, start + "great poets".length);
    const resolved = resolveAnchor(TEXT, anchor);
    expect(resolved).toEqual({ start, end: start + "great poets".length, reanchored: false });
  });

  it("re-anchors by quote when text shifted", () => {
    const start = TEXT.indexOf("great poets");
    const anchor = makeAnchor(TEXT, start, start + "great poets".length);
    const shifted = "PREFACE ADDED. " + TEXT;
    const resolved = resolveAnchor(shifted, anchor);
    expect(resolved?.reanchored).toBe(true);
    expect(shifted.slice(resolved!.start, resolved!.end)).toBe("great poets");
  });

  it("picks the occurrence whose prefix/suffix matches", () => {
    const text = "alpha read beta. gamma read delta. multitude read the end.";
    const anchor = {
      char_start: 999,
      char_end: 1003,
      quote: "read",
      prefix: "gamma ",
      suffix: " delta",
    };
    const resolved = resolveAnchor(text, anchor);
    expect(resolved).not.toBeNull();
    expect(text.slice(resolved!.start - 6, resolved!.end + 6)).toBe("gamma read delta");
  });

  it("returns null when the quote no longer exists", () => {
    const anchor = { char_start: 0, char_end: 4, quote: "zzzz", prefix: "", suffix: "" };
    expect(resolveAnchor(TEXT, anchor)).toBeNull();
  });
});
