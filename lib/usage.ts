import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import type { Plan } from "@/lib/types";

export interface UsageDecision {
  allowed: boolean;
  reason?: string;
  plan: Plan;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getPlan(userId: string): Promise<Plan> {
  const admin = createSupabaseAdmin();
  const { data } = await admin
    .from("profiles")
    .select("plan")
    .eq("user_id", userId)
    .maybeSingle();
  return data?.plan ?? "free";
}

/**
 * Server-side enforcement of the free tier. Free: library only, N new threads
 * per day. Pro: unlimited. Counting happens through the bump_usage RPC so it
 * is atomic under concurrent requests.
 */
export async function checkThreadCreation(userId: string): Promise<UsageDecision> {
  const plan = await getPlan(userId);
  if (plan === "pro") return { allowed: true, plan };

  const admin = createSupabaseAdmin();
  const { data } = await admin
    .from("usage_daily")
    .select("threads_created")
    .eq("user_id", userId)
    .eq("day", today())
    .maybeSingle();

  const used = data?.threads_created ?? 0;
  const limit = env.freeThreadsPerDay;
  return decideThreadCreation(plan, used, limit);
}

/** Pure decision logic, unit-testable without a database. */
export function decideThreadCreation(plan: Plan, usedToday: number, limit: number): UsageDecision {
  if (plan === "pro") return { allowed: true, plan };
  if (usedToday >= limit) {
    return {
      allowed: false,
      plan,
      reason: `Free plan is limited to ${limit} new threads per day. Upgrade to Pro for unlimited threads.`,
    };
  }
  return { allowed: true, plan };
}

export async function recordUsage(userId: string, threads: number, messages: number): Promise<void> {
  const admin = createSupabaseAdmin();
  await admin.rpc("bump_usage", {
    p_user_id: userId,
    p_threads: threads,
    p_messages: messages,
  });
}
