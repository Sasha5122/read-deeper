import { describe, expect, it } from "vitest";
import { buildThreadContext, trimHistory } from "@/lib/context";
import type { Role } from "@/lib/types";

describe("trimHistory", () => {
  const msg = (role: Role, content: string) => ({ role, content });

  it("keeps the most recent messages within the budget", () => {
    const history = [
      msg("user", "a".repeat(4000)),
      msg("assistant", "b".repeat(4000)),
      msg("user", "recent question"),
    ];
    const trimmed = trimHistory(history, 300);
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0].content).toBe("recent question");
  });

  it("always keeps the latest user message even over budget", () => {
    const trimmed = trimHistory([msg("user", "x".repeat(10000))], 10);
    expect(trimmed).toHaveLength(1);
  });

  it("never starts with an assistant message", () => {
    const history = [
      msg("user", "q1"),
      msg("assistant", "a".repeat(400)),
      msg("user", "q2"),
    ];
    const trimmed = trimHistory(history, 120);
    expect(trimmed[0].role).toBe("user");
  });
});

describe("buildThreadContext", () => {
  it("includes quote, surroundings and page, and excludes nothing from its own history", () => {
    const { system, messages } = buildThreadContext({
      documentTitle: "Meditations",
      documentAuthor: "Marcus Aurelius",
      pageNo: 12,
      quote: "the obstacle is the way",
      before: "some text before",
      after: "some text after",
      history: [
        { role: "user", content: "what does this mean?" },
        { role: "assistant", content: "it means..." },
        { role: "user", content: "simpler please" },
      ],
    });
    expect(system).toContain("Meditations");
    expect(system).toContain("page 12");
    expect(system).toContain("<passage>the obstacle is the way</passage>");
    expect(system).toContain("<before>some text before</before>");
    expect(messages).toHaveLength(3);
  });
});
