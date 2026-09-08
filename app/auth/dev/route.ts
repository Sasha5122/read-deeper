import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";

/**
 * Local-testing shortcut: signs the browser in as the seeded dev user so the
 * app can be exercised without the email flow. Only active when
 * DEV_AUTOLOGIN=1 and never in production builds.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = url.searchParams.get("next") ?? "/library";

  if (process.env.DEV_AUTOLOGIN !== "1" || process.env.NODE_ENV === "production") {
    return NextResponse.redirect(new URL("/login", url.origin));
  }

  const supabase = await createSupabaseServer();
  const { error } = await supabase.auth.signInWithPassword({
    email: process.env.DEV_USER_EMAIL ?? "dev@local.test",
    password: process.env.DEV_USER_PASSWORD ?? "dev-password-123",
  });
  if (error) {
    return new Response(`Dev auto-login failed: ${error.message}`, { status: 500 });
  }
  return NextResponse.redirect(new URL(next.startsWith("/") ? next : "/library", url.origin));
}
