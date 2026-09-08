import Stripe from "stripe";
import { NextResponse } from "next/server";
import { ApiError, handleErrors } from "@/lib/api";
import { env } from "@/lib/env";
import { requireUser } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

/** Open the Stripe billing portal for the signed-in customer. */
export const POST = handleErrors(async () => {
  const { user } = await requireUser();
  const admin = createSupabaseAdmin();
  const { data: profile } = await admin
    .from("profiles")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!profile?.stripe_customer_id) throw new ApiError(400, "No billing account yet");

  const stripe = new Stripe(env.stripeSecretKey);
  const session = await stripe.billingPortal.sessions.create({
    customer: profile.stripe_customer_id,
    return_url: `${env.appUrl}/settings`,
  });
  return NextResponse.json({ url: session.url });
});
