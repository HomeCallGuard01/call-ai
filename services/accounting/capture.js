// Accounting capture hook for the live webhook routes.
//
// OFF by default. Only ACCOUNTING_CAPTURE_ENABLED=true turns it on, and that
// must not be set until migration 071 is applied (otherwise every capture
// fails — harmlessly — and alerts).
//
// Contract with the webhook routes: capture NEVER throws and never changes
// the route's response, entitlement handling or Twilio provisioning. It only
// records the (already signature-verified) event into the accounting
// sub-ledger. It never posts to Xero — posting is a separate worker
// (scripts/accounting-run.js) that is not scheduled anywhere.
//
// A capture failure is alerted, not retried by the provider (the route still
// returns its normal status). Missed events are caught by payout/settlement
// reconciliation (unmatched_payment) and can be re-fed from the Stripe Events
// API (30-day retention) — docs/finance/ACCOUNTING_AUTOMATION.md §5.

'use strict';

const { loadAccountingPolicy } = require('./accountingPolicy');

function createAccountingCapture({ env = process.env, deps = {} } = {}) {
  let engine = null;
  const enabled = () => env.ACCOUNTING_CAPTURE_ENABLED === 'true';

  function getEngine() {
    if (engine) return engine;
    // Lazy: nothing here is loaded (or connects) unless capture is enabled.
    const { createAccountingEngine } = require('./engine');
    const { createRpcAccountingStore } = require('./rpcStore');
    const { createSupabaseResolver } = require('./resolver');
    const supabase = deps.supabase || require('../supabaseClients').supabaseAdmin;
    if (!supabase) throw new Error('service-role Supabase client not configured');
    engine = createAccountingEngine({
      store: deps.store || createRpcAccountingStore(supabase),
      resolver: deps.resolver || createSupabaseResolver(supabase),
      policy: loadAccountingPolicy(env),
    });
    return engine;
  }

  async function capture(kind, fn) {
    if (!enabled()) return { captured: false, reason: 'disabled' };
    try {
      const result = await fn(getEngine());
      return { captured: true, outcome: result.outcome };
    } catch (err) {
      console.error(`ACCOUNTING CAPTURE FAILED (${kind}):`, err.message);
      const alert = deps.sendCriticalAlert || require('../alerting').sendCriticalAlert;
      await Promise.resolve(alert('accounting_capture_failed', `Accounting capture failed for a ${kind} event`, { error: err.message })).catch(() => {});
      return { captured: false, reason: 'error', error: err.message };
    }
  }

  return {
    enabled,
    captureStripeEvent: (event) => capture('stripe', (e) => e.ingestStripeEvent(event)),
    captureRevenueCatEvent: (body) => capture('revenuecat', (e) => e.ingestRevenueCatEvent(body)),
  };
}

const accountingCapture = createAccountingCapture();

module.exports = { createAccountingCapture, accountingCapture };
