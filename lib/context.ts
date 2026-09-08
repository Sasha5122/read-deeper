import { approxTokens } from "@/lib/tokens";
import type { Role } from "@/lib/types";

export const SURROUNDING_CHARS = 600;

export interface ThreadContextInput {
  documentTitle: string;
  documentAuthor: string | null;
  pageNo: number;
  quote: string;
  before: string;
  after: string;
  outline?: string[];
  history: { role: Role; content: string }[];
  /** Budget for the trimmed history, in approximate tokens. */
  historyTokenBudget?: number;
}

export interface BuiltContext {
  system: string;
  messages: { role: Role; content: string }[];
}

export const QUICK_ACTIONS = {
  explain_simpler: "Explain this passage again, more simply, assuming less background knowledge.",
  give_example: "Give a concrete example that illustrates what this passage is saying.",
} as const;

/**
 * Build the API payload for one thread message. The thread is isolated: its
 * context is the highlighted fragment, surrounding text, and its own history —
 * never other threads.
 */
export function buildThreadContext(input: ThreadContextInput): BuiltContext {
  const {
    documentTitle,
    documentAuthor,
    pageNo,
    quote,
    before,
    after,
    outline,
    history,
    historyTokenBudget = 2000,
  } = input;

  const system = [
    "You are a patient expert reading alongside the user.",
    "Answer questions about the highlighted passage of the document they are reading.",
    "Be concrete. When the passage is ambiguous, say so.",
    "Do not summarise the whole document unless explicitly asked.",
    "",
    `Document: ${documentTitle}${documentAuthor ? ` — ${documentAuthor}` : ""}`,
    outline && outline.length > 0 ? `Document outline:\n${outline.join("\n")}` : "",
    "",
    `The user highlighted this passage on page ${pageNo}:`,
    `<passage>${quote}</passage>`,
    "",
    "Surrounding text for context:",
    `<before>${before}</before>`,
    `<after>${after}</after>`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  return { system, messages: trimHistory(history, historyTokenBudget) };
}

/**
 * Keep the most recent messages that fit the budget. The latest user message
 * is always kept even if it alone exceeds the budget.
 */
export function trimHistory(
  history: { role: Role; content: string }[],
  tokenBudget: number,
): { role: Role; content: string }[] {
  const kept: { role: Role; content: string }[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    const cost = approxTokens(msg.content) + 4;
    if (kept.length > 0 && used + cost > tokenBudget) break;
    kept.unshift(msg);
    used += cost;
  }
  // The API requires the first message to be from the user.
  while (kept.length > 0 && kept[0].role !== "user") kept.shift();
  return kept;
}
