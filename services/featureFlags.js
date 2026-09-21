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

// LANDLINE_COMING_SOON (2026-09-21): HCG landline protection is not yet
// ready to sell, so landline is presented as "Coming soon" everywhere and
// a household that says it is protecting a landline must not be able to
// reach paid checkout (or, through it, number provisioning) — see
// services/providerPolicy.js's evaluateHouseholdCheckoutEligibility,
// docs/launch/LANDLINE_COMING_SOON_FLAG.md, and the iPhone flag above,
// whose exact pattern this mirrors. The landline implementation itself
// (provider policy, activation instructions, dashboard steps) is
// deliberately left in place: this only disables customer availability.
// Defaults to true (fails toward "not available") whenever the env var is
// unset or anything other than the literal string "false".
function isLandlineComingSoon() {
  return process.env.LANDLINE_COMING_SOON !== "false";
}

module.exports = { isIosComingSoon, isLandlineComingSoon };
