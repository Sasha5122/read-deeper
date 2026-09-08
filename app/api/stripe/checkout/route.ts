import Stripe from "stripe";
import { NextResponse } from "next/server";
import { ApiError, handleErrors } from "@/lib/api";
import { env } from "@/lib/env";
import { requireUser } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

/** Start a Stripe Checkout session for the Pro subscription. */
export const POST = handleErrors(async () => {
  const { user } = await requireUser();
  const stripe = new Stripe(env.stripeSecretKey);
  const admin = createSupabaseAdmin();

  const { data: profile } = await admin
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  let customerId = profile?.stripe_customer_id ?? null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { supabase_user_id: user.id },
    });
    customerId = customer.id;
    await admin
      .from("profiles")
      .upsert({ user_id: user.id, stripe_customer_id: customerId }, { onConflict: "user_id" });
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: env.stripePricePro, quantity: 1 }],
    success_url: `${env.appUrl}/settings?checkout=success`,
    cancel_url: `${env.appUrl}/settings?checkout=cancelled`,
    metadata: { supabase_user_id: user.id },
  });
  if (!session.url) throw new ApiError(500, "Stripe did not return a checkout URL");
  return NextResponse.json({ url: session.url });
});
