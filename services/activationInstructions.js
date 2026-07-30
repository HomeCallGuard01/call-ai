// Generates the complete, ready-to-dial call-forwarding code server-side,
// so neither the mobile app nor a future web client ever needs to hold —
// or duplicate the per-provider formatting/caveat logic for — the raw
// Twilio number itself. Added per docs/mobile-app/APP_DECISION_003's own
// research (UK GSM forwarding codes are a 3GPP standard shared across
// mobile carriers; UK landline providers use the identical `*21*<number>#`
// format, with two confirmed exceptions: Virgin Media needs an extra
// leading zero, and Sky/Virgin both require a preliminary call to 150 to
// add "Call Divert" to the account before the code will work at all).
//
// This module deliberately never receives or exposes the bare Twilio
// number to any caller outside routes/mobileApi.js's own request handler
// — see that route for why the general dashboard endpoints (GET
// /api/v1/me/dashboard, the existing web /dashboard-data) continue to
// exclude it entirely; this is the one narrow, purpose-built exception.
const DEVICE_TYPES = new Set(["iphone", "android", "landline"]);
const LANDLINE_PROVIDERS = new Set(["bt", "sky", "virgin", "talktalk", "plusnet", "other"]);

// Twilio numbers this project assigns are always UK E.164 (+44...) — see
// services/twilioProvisioning.js's own number-search scoping. UK dialling
// convention for supplementary-service codes uses the national format
// (leading 0), not the international +44 prefix.
function toNationalDialingFormat(e164Number) {
  return e164Number.replace(/^\+44/, "0");
}

// Pure — directly unit-testable, no Supabase/Twilio/Express involved.
function buildActivationInstructions({ twilioNumber, deviceType, provider }) {
  if (!DEVICE_TYPES.has(deviceType)) {
    throw new Error(`buildActivationInstructions: invalid deviceType "${deviceType}"`);
  }

  if (deviceType === "landline" && !LANDLINE_PROVIDERS.has(provider)) {
    throw new Error(`buildActivationInstructions: invalid landline provider "${provider}"`);
  }

  const nationalNumber = toNationalDialingFormat(twilioNumber);

  // Virgin Media is the one confirmed exception to the universal
  // *21*<number># format — an extra leading zero before the number.
  const dialledNumber = deviceType === "landline" && provider === "virgin"
    ? `0${nationalNumber}`
    : nationalNumber;

  const code = `*21*${dialledNumber}#`;
  const cancelCode = deviceType === "landline" && provider === "virgin" ? "##21#" : "#21#";

  // Sky and Virgin both require calling 150 first to add "Call Divert" to
  // the account before the code will work — confirmed via research this
  // engagement (APP_DECISION_003). Every other provider/device type works
  // with the code alone, no preliminary step.
  const requiresPreliminaryCall = deviceType === "landline" && (provider === "sky" || provider === "virgin");

  return {
    code,
    cancelCode,
    requiresPreliminaryCall,
    preliminaryCallNumber: requiresPreliminaryCall ? "150" : null,
    preliminaryCallNote:
      provider === "sky"
        ? "Call 150 from your landline first to add Call Divert to your account (this may cost around £2.50/month)."
        : provider === "virgin"
          ? "Call 150 from your landline first to add Call Divert to your account."
          : null,
  };
}

module.exports = {
  DEVICE_TYPES,
  LANDLINE_PROVIDERS,
  toNationalDialingFormat,
  buildActivationInstructions,
};
