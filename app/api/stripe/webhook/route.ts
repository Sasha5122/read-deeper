import Stripe from "stripe";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import type { Plan } from "@/lib/types";

/**
 * Stripe webhook — the single source of truth for profiles.plan.
 * Configure with events: checkout.session.completed,
 * customer.subscription.updated, customer.subscription.deleted.
 */
export async function POST(request: Request) {
  const stripe = new Stripe(env.stripeSecretKey);
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      await request.text(),
      signature,
      env.stripeWebhookSecret,
    );
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const admin = createSupabaseAdmin();

  async function setPlanByCustomer(customerId: string, plan: Plan) {
    await admin.from("profiles").update({ plan }).eq("stripe_customer_id", customerId);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      if (typeof session.customer === "string") {
        await setPlanByCustomer(session.customer, "pro");
      }
      break;
    }
    case "customer.subscription.updated": {
      const sub = event.data.object;
      if (typeof sub.customer === "string") {
        const active = sub.status === "active" || sub.status === "trialing";
        await setPlanByCustomer(sub.customer, active ? "pro" : "free");
      }
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      if (typeof sub.customer === "string") {
        await setPlanByCustomer(sub.customer, "free");
      }
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true });
}
