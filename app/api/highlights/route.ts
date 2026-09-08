import { z } from "zod";
import { NextResponse } from "next/server";
import { ApiError, handleErrors } from "@/lib/api";
import { makeAnchor } from "@/lib/anchoring";
import { getDocumentWithPages } from "@/lib/docs";
import { requireUser } from "@/lib/supabase/server";
import { checkThreadCreation, recordUsage } from "@/lib/usage";

const CreateHighlight = z.object({
  documentId: z.string().uuid(),
  charStart: z.number().int().min(0),
  charEnd: z.number().int().positive(),
  color: z.enum(["amber", "green", "blue", "rose"]).default("amber"),
});

/** Create a highlight and its (empty) thread in one step. */
export const POST = handleErrors(async (request: Request) => {
  const { supabase, user } = await requireUser();
  const body = CreateHighlight.parse(await request.json());
  if (body.charEnd <= body.charStart) throw new ApiError(400, "Empty selection");

  const decision = await checkThreadCreation(user.id);
  if (!decision.allowed) throw new ApiError(429, decision.reason ?? "Daily limit reached");

  const { fullText } = await getDocumentWithPages(supabase, body.documentId);
  if (body.charEnd > fullText.length) throw new ApiError(400, "Selection is out of range");

  const anchor = makeAnchor(fullText, body.charStart, body.charEnd);
  if (anchor.quote.trim().length === 0) throw new ApiError(400, "Empty selection");

  const { data: highlight, error: hErr } = await supabase
    .from("highlights")
    .insert({
      document_id: body.documentId,
      user_id: user.id,
      char_start: anchor.char_start,
      char_end: anchor.char_end,
      quote: anchor.quote,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
      color: body.color,
    })
    .select("*")
    .single();
  if (hErr || !highlight) throw new ApiError(500, hErr?.message ?? "Could not save highlight");

  const { data: thread, error: tErr } = await supabase
    .from("threads")
    .insert({ highlight_id: highlight.id, user_id: user.id })
    .select("*")
    .single();
  if (tErr || !thread) {
    await supabase.from("highlights").delete().eq("id", highlight.id);
    throw new ApiError(500, tErr?.message ?? "Could not create thread");
  }

  await recordUsage(user.id, 1, 0);
  return NextResponse.json({ highlight, thread }, { status: 201 });
});
