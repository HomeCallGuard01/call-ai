const Stripe = require("stripe");

// createClient()-equivalent for Stripe: only constructed when the key is
// actually present, matching services/supabaseClients.js's fail-open
// pattern rather than crashing the whole server at require-time.
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

if (!stripe) {
  console.warn(
    "STRIPE_SECRET_KEY is not set — checkout and billing routes will not function until it is configured."
  );
}

module.exports = { stripe };
