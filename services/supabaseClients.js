const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Service-role client. Used for: the calls/contacts tables (see Decision 007
// in docs/DECISIONS.md), household lookups/creation, and Twilio webhook
// routes that have no logged-in browser session to authenticate with.
//
// createClient() throws synchronously if given an undefined key, which would
// take down the whole server before it even starts listening — so this is
// only constructed when the key is actually present, and every helper that
// uses it checks for it and fails open (matches this codebase's existing
// fail-open convention) rather than crashing.
const supabaseAdmin = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

if (!supabaseAdmin) {
  console.warn(
    "SUPABASE_SERVICE_ROLE_KEY is not set — household, contact and call data will not be read or written until it is configured."
  );
}

module.exports = { supabase, supabaseAdmin };
