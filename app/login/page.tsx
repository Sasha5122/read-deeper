"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase/client";

/**
 * Password sign-in: accounts are provisioned by the owner (invite-only test
 * phase) and handed out as email + password. No self-signup.
 */
function LoginForm() {
  const params = useSearchParams();
  const router = useRouter();
  const next = params.get("next") ?? "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const supabase = createSupabaseBrowser();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(
        error.message === "Invalid login credentials"
          ? "Email sau parolă greșite."
          : error.message,
      );
      setBusy(false);
      return;
    }
    router.replace(next.startsWith("/") ? next : "/");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="mb-1 font-[family-name:var(--font-display)] text-4xl font-semibold">
        Read Deeper
      </h1>
      <p className="mb-8 text-ink-soft">Understand any document, one highlight at a time.</p>

      <form onSubmit={signIn} className="flex flex-col gap-3">
        <label className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
          Email
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-base font-normal normal-case tracking-normal text-ink"
          />
        </label>
        <label className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
          Parolă
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-base font-normal normal-case tracking-normal text-ink"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-accent px-4 py-2 font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
        >
          {busy ? "Se conectează…" : "Intră"}
        </button>
      </form>
      {error && <p className="mt-4 text-sm text-red-700">{error}</p>}
      <p className="mt-6 text-xs text-ink-faint">
        Cont de test primit de la Sasha? Folosește exact emailul și parola primite.
      </p>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
