import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { UnauthorizedError } from "@/lib/supabase/server";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

/** Wrap a route handler with uniform auth/validation/error responses. */
export function handleErrors<Args extends unknown[]>(
  fn: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof UnauthorizedError) return jsonError(401, "Not signed in");
      if (err instanceof ApiError) return jsonError(err.status, err.message);
      if (err instanceof ZodError) return jsonError(400, err.issues.map((i) => i.message).join("; "));
      console.error(err);
      return jsonError(500, "Something went wrong");
    }
  };
}
