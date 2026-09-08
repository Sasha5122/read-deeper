"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase/client";
import type { Plan } from "@/lib/types";

export function SettingsActions({ plan }: { plan: Plan }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function post(url: string) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(url, { method: "POST" });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? "Request failed");
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
      setBusy(false);
    }
  }

  async function signOut() {
    await createSupabaseBrowser().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      {plan === "free" ? (
        <button
          onClick={() => void post("/api/stripe/checkout")}
          disabled={busy}
          className="rounded-md bg-accent px-4 py-2 font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
        >
          Upgrade to Pro
        </button>
      ) : (
        <button
          onClick={() => void post("/api/stripe/portal")}
          disabled={busy}
          className="rounded-md border border-line bg-surface px-4 py-2 font-semibold hover:border-accent disabled:opacity-60"
        >
          Manage billing
        </button>
      )}
      <button
        onClick={() => void signOut()}
        className="rounded-md border border-line bg-surface px-4 py-2 font-semibold text-ink-soft hover:text-ink"
      >
        Sign out
      </button>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
