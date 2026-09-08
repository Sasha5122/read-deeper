import { Nav } from "@/components/Nav";
import { SettingsActions } from "@/components/settings/SettingsActions";
import { requireUser } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { getPlan } from "@/lib/usage";

export default async function SettingsPage() {
  const { supabase, user } = await requireUser();
  const plan = await getPlan(user.id);

  const today = new Date().toISOString().slice(0, 10);
  const { data: usage } = await supabase
    .from("usage_daily")
    .select("*")
    .eq("user_id", user.id)
    .eq("day", today)
    .maybeSingle();

  return (
    <>
      <Nav active="settings" />
      <main className="mx-auto max-w-md px-4 py-10">
        <h1 className="mb-6 font-[family-name:var(--font-display)] text-3xl font-semibold">
          Settings
        </h1>
        <div className="mb-6 rounded-lg border border-line bg-surface p-5">
          <p className="text-sm text-ink-soft">Signed in as</p>
          <p className="mb-4 font-semibold">{user.email}</p>
          <p className="text-sm text-ink-soft">Plan</p>
          <p className="mb-1 font-semibold capitalize">{plan}</p>
          {plan === "free" && (
            <p className="text-xs text-ink-faint">
              {usage?.threads_created ?? 0} of {env.freeThreadsPerDay} free threads used today.
              Pro unlocks uploads and unlimited threads.
            </p>
          )}
        </div>
        <SettingsActions plan={plan} />
      </main>
    </>
  );
}
