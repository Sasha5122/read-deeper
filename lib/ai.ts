import OpenAI from "openai";
import { env } from "@/lib/env";

/**
 * Thin OpenAI wrapper for the four operations the app needs. GPT-5 models are
 * reasoning models: cheap/fast jobs must pass effort "minimal" or they burn
 * their whole output budget thinking (verified live during the key test).
 */

let client: OpenAI | null = null;
export function openai(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: env.openaiApiKey });
  return client;
}

export type Effort = "minimal" | "low" | "medium" | "high";

export interface AiTextOptions {
  model: string;
  system?: string;
  input: string | OpenAI.Responses.ResponseInput;
  effort?: Effort;
  maxOutputTokens?: number;
  /** Enable the built-in web_search tool for this call. */
  webSearch?: boolean;
}

function baseParams(opts: AiTextOptions) {
  return {
    model: opts.model,
    input: opts.input,
    ...(opts.system ? { instructions: opts.system } : {}),
    ...(opts.effort ? { reasoning: { effort: opts.effort } } : {}),
    ...(opts.maxOutputTokens ? { max_output_tokens: opts.maxOutputTokens } : {}),
    ...(opts.webSearch ? { tools: [{ type: "web_search" as const }] } : {}),
  };
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

/** One-shot text answer. */
export async function aiText(
  opts: AiTextOptions,
): Promise<{ text: string; usage: AiUsage }> {
  const res = await openai().responses.create(baseParams(opts));
  return {
    text: res.output_text ?? "",
    usage: {
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
    },
  };
}

/**
 * Structured output: the model must return JSON matching `schema`
 * (a JSON Schema object). Returns the parsed value.
 */
export async function aiJson<T>(
  opts: AiTextOptions & { schemaName: string; schema: Record<string, unknown> },
): Promise<{ value: T; usage: AiUsage }> {
  const res = await openai().responses.create({
    ...baseParams(opts),
    text: {
      format: {
        type: "json_schema",
        name: opts.schemaName,
        strict: true,
        schema: opts.schema,
      },
    },
  });
  const raw = res.output_text ?? "";
  return {
    value: JSON.parse(raw) as T,
    usage: {
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
    },
  };
}

/**
 * Streamed text answer. Calls onDelta for each text chunk; resolves with the
 * final text + usage once the stream completes.
 */
export async function aiStreamText(
  opts: AiTextOptions,
  onDelta: (text: string) => void,
): Promise<{ text: string; usage: AiUsage }> {
  const stream = openai().responses.stream(baseParams(opts));
  stream.on("response.output_text.delta", (e) => onDelta(e.delta));
  const final = await stream.finalResponse();
  return {
    text: final.output_text ?? "",
    usage: {
      inputTokens: final.usage?.input_tokens ?? 0,
      outputTokens: final.usage?.output_tokens ?? 0,
    },
  };
}

/** Embeddings for a batch of texts (order preserved). */
export async function aiEmbed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  // API limit safety: batch by 100 inputs
  for (let i = 0; i < texts.length; i += 100) {
    const res = await openai().embeddings.create({
      model: env.modelEmbedding,
      input: texts.slice(i, i + 100),
    });
    for (const d of res.data) out[i + d.index] = d.embedding;
  }
  return out;
}
