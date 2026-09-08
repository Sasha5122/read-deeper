import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import type { Database } from "@/lib/types";

/**
 * Service-role client. Bypasses RLS — server-side only, and only where user
 * scoping is enforced in code (usage counters, processing jobs, webhooks).
 */
export function createSupabaseAdmin() {
  return createClient<Database>(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
