"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase/client";

function LoginForm() {
  const params = useSearchParams();
  const next = params.get("next") ?? "/library";
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  const supabase = createSupabaseBrowser();
  const redirectTo = `${typeof window !== "undefined" ? window.location.origin : ""}/auth/callback?next=${encodeURIComponent(next)}`;

  async function signInWithEmail(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    if (error) {
      setError(error.message);
      setStatus("error");
    } else {
      setStatus("sent");
    }
  }

  async function signInWithGoogle() {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="mb-1 font-[family-name:var(--font-display)] text-4xl font-semibold">
        Read Deeper
      </h1>
      <p className="mb-8 text-ink-soft">Understand any document, one highlight at a time.</p>

      {status === "sent" ? (
        <p className="rounded-lg border border-line bg-surface p-4 text-sm">
          Check your inbox — we sent a sign-in link to <strong>{email}</strong>.
        </p>
      ) : (
        <>
          <form onSubmit={signInWithEmail} className="flex flex-col gap-3">
            <label className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
              Email
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-base font-normal normal-case tracking-normal text-ink"
              />
            </label>
            <button
              type="submit"
              disabled={status === "sending"}
              className="rounded-md bg-accent px-4 py-2 font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
            >
              {status === "sending" ? "Sending…" : "Send sign-in link"}
            </button>
          </form>
          <div className="my-5 flex items-center gap-3 text-xs text-ink-faint">
            <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
          </div>
          <button
            onClick={signInWithGoogle}
            className="rounded-md border border-line bg-surface px-4 py-2 font-semibold hover:border-accent"
          >
            Continue with Google
          </button>
          {status === "error" && <p className="mt-4 text-sm text-red-700">{error}</p>}
        </>
      )}
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
