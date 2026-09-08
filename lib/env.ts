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
  /** Routing-ticket classifier — cheapest tier, minimal reasoning. */
  get modelDispatcher() {
    return process.env.MODEL_DISPATCHER ?? "gpt-5-nano";
  },
  /** Trivial lookups: synonyms, translations, term definitions. */
  get modelLookup() {
    return process.env.MODEL_LOOKUP ?? "gpt-5-nano";
  },
  get modelEmbedding() {
    return process.env.MODEL_EMBEDDING ?? "text-embedding-3-small";
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
