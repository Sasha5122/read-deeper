# Task: Rebuild the margin-answer pipeline for maximum answer quality

## Why
The current pipeline (router -> tier -> trimmed context -> summarised history -> constrained answer prompt) produces thin, generic answers. Every stage saves tokens and loses quality. We are replacing it with: best model + full document + full thread history + reasoning + streaming. Cost is a secondary concern; quality is the product.

Read the current implementation first (routing dispatcher, tier config, context builder, plain mode, conversation summariser, document summariser). Then implement the changes below. Keep the diff focused: do not refactor unrelated code.

## 1. Remove the routing dispatcher
- Delete the router call and the tier system (lookup / passage / document / research).
- Delete `surrounding`, `rag_chunks`, `use_summary`, `answer_length`, `register`, `conversation` parameters and all code paths that branch on them.
- Delete the FAILED-UNDERSTANDING LOOP escalation logic.
- Delete PLAIN MODE entirely (the whole block).
- Keep exactly one cheap pre-step, run in parallel with the answer request (never before it): a classifier that returns `{ web: boolean }` — true only when the question needs information that cannot be in the document (author background, reception, replication, later events). If it returns true, the answer request gets the web-search line and web tool enabled; if the classifier is slow (>800 ms) proceed without web rather than delaying the answer.

## 2. Full document in context
- If the document's total token count is <= `DOC_FULL_CONTEXT_MAX_TOKENS` (env, default 150000), send the ENTIRE document text with page markers (`<!-- page N -->`) as the first, static part of the prompt. No RAG, no document map.
- Structure the prompt so the static prefix (system prompt + full document) is byte-identical across requests for the same document, then the variable part (passage, history, question). This is what makes provider prompt caching work. Verify cache hits in logs.
- Only if the document exceeds the limit: keep RAG, but with `rag_chunks = 12`, chunk size ~1500 tokens with 200 overlap, and always include the 3 pages around the highlight in full. The document summary is then used only in this oversized branch.
- Remove the per-block 300-word summary limit; if a summary is needed for oversized docs, allow ~150 words per 10 pages.

## 3. Full thread history
- Always send the complete message history of the thread (it is per-highlight, so it is small). Remove the rolling conversation summary (nano, every ~4 messages) and the "none / last2 / summary / full" logic.
- Only if a thread exceeds 40 messages, summarise the oldest 20 with the main model once and keep the rest verbatim.

## 4. Models and reasoning
- `MODEL_ANSWER`: the strongest model available (env). Reasoning enabled: `REASONING_EFFORT_ANSWER` env, default `medium`. Do not use mini/nano for any user-facing answer text.
- `MODEL_UTILITY` (mini): thread titles, the web classifier, oversized-doc summaries only.
- Quick actions ("explain simpler", "give example") go through the same answer pipeline as a normal message — no separate prompt, no register flag.

## 5. The single answer system prompt
Replace all answer prompts with this one:

```
You are an expert reading alongside the reader, answering about the passage they highlighted in the document below.
You have the full document; use it freely and cite pages like (p. 4). Quote the text briefly when it helps.
Stay faithful to the document. If something is not in it, say so, then answer from general knowledge if you can, clearly marked as such.
Match the reader's level and the language of their question. If they ask for a simpler explanation, explain simply without talking down to them.
Be as thorough as the question deserves: give the reasoning, an example or consequence where useful, and note important nuances. Do not pad, do not restate the question.
Use light Markdown (bold for key terms, short lists only when they genuinely help).
```

Append only when `web=true`:
```
You may search the web when the document cannot answer. Keep document-sourced and web-sourced content clearly separated, and cite web sources.
```

Message layout (in this order): system prompt -> document title/author/type -> full document text -> `<passage>` (highlighted quote with page) -> full thread history -> current question.

## 6. Streaming and latency
- Stream the answer; first visible token target < 1.5 s. Nothing may run serially before the answer request except loading the cached document text from DB.
- Show reasoning/thinking as a subtle "thinking…" state, never as blank.
- Render Markdown incrementally.

## 7. Search ("Find by meaning")
- Keep, but use `MODEL_ANSWER` and, for documents within the full-context limit, send the whole document instead of RAG excerpts.

## 8. Config / env
`MODEL_ANSWER`, `MODEL_UTILITY`, `REASONING_EFFORT_ANSWER`, `DOC_FULL_CONTEXT_MAX_TOKENS`, `WEB_CLASSIFIER_TIMEOUT_MS`. Remove env vars that only served the tier system.

## 9. Observability
Log per request: model, cached prefix tokens, uncached input tokens, output tokens, reasoning tokens, time-to-first-token, total latency, web=true/false, doc token count, full-context vs RAG branch. Add a simple per-user daily cost estimate.

## 10. Verification before you finish
- Build an eval script with 12 fixed questions on 2 documents (one short article, one 300-page book): definition question, interpretive question, "explain simpler" follow-up, cross-section question, "main conclusion" question, external-fact question (must trigger web), non-English question, and a 5-message continued thread.
- Run old pipeline vs new on all 12, save both outputs side by side in `/eval/results.md`. Do not delete the old pipeline until this file exists.
- Confirm prompt-cache hits >= 80% on the second and later requests for the same document.
- Confirm TTFT < 1.5 s on the short document and < 3 s on the book.

Do not add new abstractions, config layers or "smart" heuristics. The whole point of this change is fewer moving parts.
