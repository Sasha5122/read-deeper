import { z } from "zod";
import { NextResponse } from "next/server";
import { ApiError, handleErrors } from "@/lib/api";
import { requireUser } from "@/lib/supabase/server";

const Params = z.object({ highlightId: z.string().uuid() });

/** Delete a highlight; its thread and messages cascade. */
export const DELETE = handleErrors(
  async (_request: Request, ctx: { params: Promise<{ highlightId: string }> }) => {
    const { supabase } = await requireUser();
    const { highlightId } = Params.parse(await ctx.params);

    const { error, count } = await supabase
      .from("highlights")
      .delete({ count: "exact" })
      .eq("id", highlightId);
    if (error) throw new ApiError(500, error.message);
    if (!count) throw new ApiError(404, "Highlight not found");
    return NextResponse.json({ ok: true });
  },
);
