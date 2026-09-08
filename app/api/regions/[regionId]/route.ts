import { z } from "zod";
import { NextResponse } from "next/server";
import { ApiError, handleErrors } from "@/lib/api";
import { requireUser } from "@/lib/supabase/server";

/** Delete a captured region; its thread and messages cascade. */
export const DELETE = handleErrors(
  async (_request: Request, ctx: { params: Promise<{ regionId: string }> }) => {
    const { supabase } = await requireUser();
    const { regionId } = z.object({ regionId: z.string().uuid() }).parse(await ctx.params);

    const { error, count } = await supabase
      .from("regions")
      .delete({ count: "exact" })
      .eq("id", regionId);
    if (error) throw new ApiError(500, error.message);
    if (!count) throw new ApiError(404, "Region not found");
    return NextResponse.json({ ok: true });
  },
);
