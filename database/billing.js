const { supabaseAdmin } = require("../services/supabaseClients");

// Every one of these goes through the narrow RPCs from
// supabase/migrations/013_stripe_billing_rpc_functions.sql and
// 014_claim_stripe_webhook_event_rpc.sql, or a plain read — never a direct
// `.from("households").update(...)`. service_role has no UPDATE grant on
// households at all (migration 012, deliberate); the RPCs are the only
// write path for households.stripe_customer_id.

// Sets households.stripe_customer_id via the RPC. Idempotent: a call with
// the same value that's already set is a no-op success. A call with a
// *different* value than what's already set throws — see the RPC's own
// comment for why (a household should never legitimately be re-pointed at
// a different Stripe Customer).
async function setHouseholdStripeCustomerId(householdId, stripeCustomerId) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { error } = await supabaseAdmin.rpc("set_household_stripe_customer_id", {
    p_household_id: householdId,
    p_stripe_customer_id: stripeCustomerId,
  });

  if (error) {
    console.error("STRIPE CUSTOMER ID SET ERROR:", error);
    throw error;
  }
}

async function getHouseholdByStripeCustomerId(stripeCustomerId) {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from("households")
    .select("*")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();

  if (error) {
    console.error("SUPABASE HOUSEHOLD BY STRIPE CUSTOMER READ ERROR:", error);
    return null;
  }

  return data;
}

// Claims a webhook event for processing via the dedup RPC (see that
// migration's comment for the full claim/retry semantics). Returns true if
// this call should proceed to process the event, false if it's already
// terminal (processed/ignored) or another attempt currently owns it — the
// caller should return 200 to Stripe either way.
async function claimWebhookEvent({ stripeEventId, eventType, stripeCustomerId, householdId, payload }) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { data, error } = await supabaseAdmin.rpc("claim_stripe_webhook_event", {
    p_stripe_event_id: stripeEventId,
    p_event_type: eventType,
    p_stripe_customer_id: stripeCustomerId,
    p_household_id: householdId,
    p_payload: payload,
  });

  if (error) {
    console.error("STRIPE WEBHOOK EVENT CLAIM ERROR:", error);
    throw error;
  }

  return data === true;
}

// Applies one already-claimed event's business effects (subscription
// upsert, entitlement transition, event status) atomically. Returns
// 'processed' or 'failed' — never throws; a thrown error here would mean
// supabaseAdmin itself is unreachable, not a business-logic failure (those
// are caught inside the RPC and recorded on the event row already).
async function processWebhookEvent({
  stripeEventId,
  householdId,
  stripeCustomerId,
  stripeSubscriptionId,
  stripePriceId,
  subscriptionStatus,
  currentPeriodEnd,
  cancelAtPeriodEnd,
}) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { data, error } = await supabaseAdmin.rpc("process_stripe_webhook_event", {
    p_stripe_event_id: stripeEventId,
    p_household_id: householdId,
    p_stripe_customer_id: stripeCustomerId,
    p_stripe_subscription_id: stripeSubscriptionId,
    p_stripe_price_id: stripePriceId,
    p_subscription_status: subscriptionStatus,
    p_current_period_end: currentPeriodEnd,
    p_cancel_at_period_end: cancelAtPeriodEnd,
  });

  if (error) {
    console.error("STRIPE WEBHOOK EVENT PROCESS ERROR:", error);
    throw error;
  }

  return data;
}

// Decision 009's own stated rule for "is this household currently
// protected", implemented verbatim: an entitlements row that is active
// right now — never by asking Stripe whether a subscription exists.
async function getActiveEntitlement(householdId) {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from("entitlements")
    .select("*")
    .eq("household_id", householdId)
    .eq("status", "active")
    .lte("starts_at", new Date().toISOString())
    .or(`ends_at.is.null,ends_at.gt.${new Date().toISOString()}`)
    .maybeSingle();

  if (error) {
    console.error("SUPABASE ENTITLEMENT READ ERROR:", error);
    return null;
  }

  return data;
}

module.exports = {
  setHouseholdStripeCustomerId,
  getHouseholdByStripeCustomerId,
  claimWebhookEvent,
  processWebhookEvent,
  getActiveEntitlement,
};
