import { z } from "zod";
import { NextResponse } from "next/server";
import { ApiError, handleErrors } from "@/lib/api";
import { requireUser } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { checkThreadCreation, recordUsage } from "@/lib/usage";

const CreateRegion = z.object({
  documentId: z.string().uuid(),
  pageNo: z.number().int().min(1),
  x: z.number().min(0),
  y: z.number().min(0),
  w: z.number().positive(),
  h: z.number().positive(),
  color: z.enum(["amber", "green", "blue", "rose"]).default("amber"),
  /** data:image/png;base64,... — the captured pixels, exactly what the user saw */
  image: z.string().max(8_000_000),
});

/** Create a captured region + its chat thread in one step. */
export const POST = handleErrors(async (request: Request) => {
  const { supabase, user } = await requireUser();
  const body = CreateRegion.parse(await request.json());

  const decision = await checkThreadCreation(user.id);
  if (!decision.allowed) throw new ApiError(429, decision.reason ?? "Daily limit reached");

  const m = /^data:image\/png;base64,(.+)$/.exec(body.image);
  if (!m) throw new ApiError(400, "image must be a PNG data URL");
  const png = Buffer.from(m[1], "base64");
  if (png.length < 100) throw new ApiError(400, "Captured image is empty");

  const { data: region, error: rErr } = await supabase
    .from("regions")
    .insert({
      document_id: body.documentId,
      user_id: user.id,
      page_no: body.pageNo,
      x: body.x,
      y: body.y,
      w: body.w,
      h: body.h,
      color: body.color,
    })
    .select("*")
    .single();
  if (rErr || !region) throw new ApiError(500, rErr?.message ?? "Could not save the capture");

  const admin = createSupabaseAdmin();
  const storagePath = `captures/${body.documentId}/${region.id}.png`;
  const { error: upErr } = await admin.storage
    .from("elements")
    .upload(storagePath, png, { contentType: "image/png", upsert: true });
  if (!upErr) {
    await admin.from("regions").update({ storage_path: storagePath }).eq("id", region.id);
  }

  const { data: thread, error: tErr } = await supabase
    .from("threads")
    .insert({ region_id: region.id, user_id: user.id })
    .select("*")
    .single();
  if (tErr || !thread) {
    await supabase.from("regions").delete().eq("id", region.id);
    throw new ApiError(500, tErr?.message ?? "Could not create thread");
  }

  await recordUsage(user.id, 1, 0);
  return NextResponse.json(
    { region: { ...region, storage_path: upErr ? null : storagePath }, thread },
    { status: 201 },
  );
});
