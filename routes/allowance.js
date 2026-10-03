// routes/allowance.js — customer allowance endpoints (customer allowance
// workstream, 2026-10-03; NOT deployed).
//
//   GET  /api/v1/me/allowance            mobile: the canonical read model
//   POST /billing/topup-checkout         web: Stripe Checkout for a top-up
//   POST /admin/api/households/:id/allowance-adjustment   admin, audited
//
// Nothing here accepts an allowance, usage figure, price or quantity from
// the client. The household always comes from the verified session; a
// top-up product code is only a choice among the server's own current
// offer, and the minutes credited are stamped server-side and credited by
// the verified webhook — never by this route.
'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { requireAuthApi } = require('../middleware/requireAuthApi');
const { requireEntitlement } = require('../middleware/requireEntitlement');
const { requireAdmin } = require('../middleware/requireAdmin');
const { getActiveEntitlement, getSubscriptionByHouseholdId } = require('../database/billing');
const customerAllowanceDb = require('../database/customerAllowance');
const { stripe } = require('../services/stripeClient');
const { getCustomerAllowance } = require('../services/allowance/customerAllowance');
const { allowanceReadDeps } = require('../services/allowance/allowanceDeps');
const { resolveTopUpProducts } = require('../services/allowance/productCatalog');
const { buildTopUpCheckoutParams } = require('../services/allowance/topUpCredit');
const { applyAdminAdjustment } = require('../services/allowance/allowanceAdjustments');

const router = express.Router();

async function readModelFor(req, platform) {
  const subscription = req.entitlement && req.entitlement.source === 'stripe'
    ? await getSubscriptionByHouseholdId(req.household.id) : null;
  return getCustomerAllowance({ household: req.household, entitlement: req.entitlement, subscription, platform, deps: allowanceReadDeps });
}

// `platform` only chooses which sales channel's top-ups are listed (an
// iPhone can only be offered Apple products); it cannot change any figure.
router.get('/api/v1/me/allowance', requireAuthApi, requireEntitlement, async (req, res) => {
  const platform = ['ios', 'android'].includes(req.query.platform) ? req.query.platform : 'unknown';
  try {
    res.json({ customerAllowance: await readModelFor(req, platform) });
  } catch (err) {
    console.error('ALLOWANCE READ ERROR:', err.message);
    res.status(500).json({ error: 'failed' });
  }
});

router.post('/billing/topup-checkout', requireAuth, requireEntitlement, express.urlencoded({ extended: false }), async (req, res) => {
  const fail = (code) => res.redirect(303, `/dashboard?topup=${code}`);
  if (process.env.ALLOWANCE_TOPUPS_ENABLED !== 'true') return fail('unavailable');
  if (!stripe || !process.env.APP_URL) return fail('error');
  try {
    // The offer is recomputed here, server-side: the product must be one
    // the read model offers this household on the web right now (enabled,
    // margin-viable, not a payment-issue or test membership, not about to
    // reset).
    const model = await readModelFor(req, 'web');
    const code = String((req.body && req.body.product) || '');
    const offered = model.topUp.available && model.topUp.products.find((p) => p.code === code);
    if (!offered) return fail('unavailable');
    const product = resolveTopUpProducts().products.find((p) => p.code === code);
    const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
    const session = await stripe.checkout.sessions.create(
      buildTopUpCheckoutParams({ householdId: req.household.id, stripeCustomerId: req.household.stripe_customer_id || null, product, appUrl: process.env.APP_URL }),
      { idempotencyKey: `topup:${req.household.id}:${code}:${bucket}` }
    );
    return res.redirect(303, session.url);
  } catch (err) {
    console.error('TOPUP CHECKOUT ERROR:', err.message);
    return fail('error');
  }
});

router.post('/admin/api/households/:id/allowance-adjustment', requireAuth, requireAdmin, express.json(), async (req, res) => {
  const { minutes, reason, idempotencyKey } = req.body || {};
  try {
    const result = await applyAdminAdjustment(
      { householdId: req.params.id, actor: req.authUserId, minutes, reason, idempotencyKey },
      { deps: { getActiveEntitlement, getSubscriptionByHouseholdId, creditAllowance: customerAllowanceDb.creditAllowance } }
    );
    if (!result.ok) return res.status(400).json({ error: result.error });
    console.log('ADMIN ALLOWANCE ADJUSTMENT', { householdId: req.params.id, actor: req.authUserId, minutes, credited: result.credited, duplicate: Boolean(result.duplicate) });
    res.json(result);
  } catch (err) {
    console.error('ADMIN ALLOWANCE ADJUSTMENT ERROR:', err.message);
    res.status(500).json({ error: 'failed' });
  }
});

module.exports = router;
