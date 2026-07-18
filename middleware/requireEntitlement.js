const { getActiveEntitlement } = require("../database/billing");

// Must run after requireAuth (needs req.household). Gates JSON API routes
// that require an active subscription, not just a logged-in session — per
// the access-control policy: authenticated user AND active entitlement for
// everything except register/login/confirm/forgot-password/subscribe/
// billing-portal. Responds 402 with a small JSON body rather than
// redirecting, since every route this is applied to is consumed via
// fetch(), not a full-page navigation (contrast with requireAuth's
// redirect-to-login behaviour).
async function requireEntitlement(req, res, next) {
  const entitlement = await getActiveEntitlement(req.household.id);

  if (!entitlement) {
    return res.status(402).json({ error: "not_entitled" });
  }

  req.entitlement = entitlement;
  next();
}

module.exports = { requireEntitlement };
