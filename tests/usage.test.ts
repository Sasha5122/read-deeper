import { describe, expect, it } from "vitest";
import { decideThreadCreation } from "@/lib/usage";

describe("decideThreadCreation", () => {
  it("always allows pro", () => {
    expect(decideThreadCreation("pro", 9999, 5).allowed).toBe(true);
  });

  it("allows free under the limit", () => {
    expect(decideThreadCreation("free", 4, 5).allowed).toBe(true);
  });

  it("blocks free at the limit with a reason", () => {
    const d = decideThreadCreation("free", 5, 5);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/5/);
  });
});
