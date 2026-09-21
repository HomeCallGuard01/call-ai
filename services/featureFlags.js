// Feature/launch flags — deliberately simple env-var-backed toggles, not
// a database table or remote config service, matching this codebase's
// existing "versioned code config, not a DB table" pattern (see
// services/providerPolicy.js's own header for the same reasoning). A
// single source of truth, read by every surface that needs to agree —
// backend checkout gates, the waiting-list capture reason, the public
// homepage banner, and (once a future mobile build exists) the app's own
// device-picker — so flipping one env var and redeploying the backend is
// the entire "Apple approved us" removal step.
//
// IOS_COMING_SOON (2026-09-19): while Apple App Store review/approval is
// pending, new iPhone customers must not be able to reach paid checkout,
// and the public homepage/onboarding must say "coming soon" rather than
// imply the iPhone app is available today — see
// docs/launch/IOS_COMING_SOON_LAUNCH_FLAG.md for the full design and the
// exact removal steps. Defaults to true (fails toward "not yet
// available" rather than accidentally selling to a customer the product
// can't yet serve) whenever the env var is unset or anything other than
// the literal string "false".
function isIosComingSoon() {
  return process.env.IOS_COMING_SOON !== "false";
}

// LANDLINE_COMING_SOON (2026-09-21): no loop-safe way exists yet to deliver
// an approved call back to a landline handset (Test 3 on a real BT Digital
// Voice line, 2026-09-21, showed the carrier diverts the return leg straight
// back to Home Call Guard), so NEW landline customers must not be able to pay
// for or set up a service that cannot work for them. Same shape and same
// fail-closed default as IOS_COMING_SOON above: true whenever the env var is
// unset or anything other than the literal string "false".
//
// This is the single authoritative source. It is read by
// services/providerPolicy.js's evaluateHouseholdCheckoutEligibility (the one
// server-side gate every checkout/pre-check route goes through — website,
// current app, older app builds and direct API calls alike) and published via
// GET /api/v1/launch-flags as `landlineComingSoon`, which the website and the
// mobile app read to decide what to show. Restoring landline = set
// LANDLINE_COMING_SOON=false and redeploy; the existing landline provider
// rules are left intact underneath the flag (see providerPolicy.js). See
// docs/launch/LANDLINE_COMING_SOON_LAUNCH_FLAG.md.
function isLandlineComingSoon() {
  return process.env.LANDLINE_COMING_SOON !== "false";
}

module.exports = { isIosComingSoon, isLandlineComingSoon };
