/**
 * Long-lived auth cookies: the session survives browser restarts for six
 * months. Supabase refreshes the access token silently in the background,
 * so a signed-in user is never re-prompted for their password unless they
 * sign out (or stay away longer than this window).
 */
export const AUTH_COOKIE_OPTIONS = {
  maxAge: 60 * 60 * 24 * 180, // 180 days
  sameSite: "lax" as const,
  path: "/",
};
