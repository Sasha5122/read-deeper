import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";

/** OAuth / magic-link landing: exchange the code for a session cookie. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/library";

  if (code) {
    const supabase = await createSupabaseServer();
    await supabase.auth.exchangeCodeForSession(code);
  }
  return NextResponse.redirect(new URL(next.startsWith("/") ? next : "/library", url.origin));
}
