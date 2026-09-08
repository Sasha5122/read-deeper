function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  get anthropicApiKey() {
    return required("ANTHROPIC_API_KEY");
  },
  get openaiApiKey() {
    return required("OPENAI_API_KEY");
  },
  get hasOpenAI() {
    return !!process.env.OPENAI_API_KEY;
  },
  /** V2: the one model that writes every user-facing answer. */
  get modelAnswer() {
    return process.env.MODEL_ANSWER ?? "gpt-5";
  },
  /** V2: utility jobs only — web classifier, oversized-doc summaries. */
  get modelUtility() {
    return process.env.MODEL_UTILITY ?? "gpt-5-mini";
  },
  get reasoningEffortAnswer() {
    return (process.env.REASONING_EFFORT_ANSWER ?? "medium") as "minimal" | "low" | "medium" | "high";
  },
  /** Documents at or under this token count go into context WHOLE. */
  get docFullContextMaxTokens() {
    return Number(process.env.DOC_FULL_CONTEXT_MAX_TOKENS ?? "150000");
  },
  get webClassifierTimeoutMs() {
    return Number(process.env.WEB_CLASSIFIER_TIMEOUT_MS ?? "800");
  },
  get modelEmbedding() {
    return process.env.MODEL_EMBEDDING ?? "text-embedding-3-small";
  },
  // LEGACY (V1 tier pipeline) — kept only until eval/results.md exists, then deleted.
  get modelDispatcher() {
    return process.env.MODEL_DISPATCHER ?? "gpt-5-nano";
  },
  get modelLookup() {
    return process.env.MODEL_LOOKUP ?? "gpt-5-nano";
  },
  get supabaseUrl() {
    return required("NEXT_PUBLIC_SUPABASE_URL");
  },
  get supabaseAnonKey() {
    return required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  },
  get supabaseServiceRoleKey() {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },
  get stripeSecretKey() {
    return required("STRIPE_SECRET_KEY");
  },
  get stripeWebhookSecret() {
    return required("STRIPE_WEBHOOK_SECRET");
  },
  get stripePricePro() {
    return required("STRIPE_PRICE_PRO");
  },
  /** Workhorse: passage explanations, vision on captures. */
  get modelThread() {
    return process.env.MODEL_THREAD ?? "gpt-5-mini";
  },
  /** Heavy tier: document-level reasoning, escalations, agent loop. */
  get modelDocument() {
    return process.env.MODEL_DOCUMENT ?? "gpt-5";
  },
  get freeThreadsPerDay() {
    return Number(process.env.FREE_THREADS_PER_DAY ?? "5");
  },
  get appUrl() {
    return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  },
};
