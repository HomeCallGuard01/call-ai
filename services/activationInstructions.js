// Generates the complete, ready-to-dial call-forwarding code server-side,
// so neither the mobile app nor a future web client ever needs to hold —
// or duplicate the per-provider formatting/caveat logic for — the raw
// Twilio number itself. Added per docs/mobile-app/APP_DECISION_003's own
// research (UK GSM forwarding codes are a 3GPP standard shared across
// mobile carriers; UK landline providers use the identical
// `**21*<number>#` registration format, with two confirmed exceptions:
// Virgin Media needs an extra leading zero, and Sky/Virgin both require a
// preliminary call to 150 to add "Call Divert" to the account before the
// code will work at all). APP_DECISION_003 itself documented this as
// `*21*<number>#` (single asterisk) — corrected 2026-09-07 after a real
// Android device rejected that form as an invalid MMI code; see
// buildActivationInstructions's own comment on the code line below for
// the grammar/root-cause detail.
//
// This module deliberately never receives or exposes the bare Twilio
// number to any caller outside routes/mobileApi.js's own request handler
// — see that route for why the general dashboard endpoints (GET
// /api/v1/me/dashboard, the existing web /dashboard-data) continue to
// exclude it entirely; this is the one narrow, purpose-built exception.
const { getMobileDeactivationInstructions } = require("./providerPolicy");

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
// carrier is the mobile network key (services/providerPolicy.js's
// PROVIDER_POLICY keys, e.g. 'o2', 'vodafone') — landline-only, ignored
// for deviceType 'landline'. Optional: today no route/household field
// actually captures it yet (P0 Batch 1 scope — carrier capture is a
// deferred P1 mobile-screen item), so in practice every current call site
// passes carrier as undefined and gets the honest "not confirmed"
// fallback below, never a fabricated universal code.
function buildActivationInstructions({ twilioNumber, deviceType, provider, carrier }) {
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

  // 3GPP TS 22.030's MMI grammar distinguishes Registration (`**`, supply
  // a new number) from Activation (`*`, use the number already
  // registered, no parameter). *21*<number># is not a valid production
  // of that grammar — registering a genuinely new forwarding destination
  // requires the double-asterisk Registration form. Confirmed wrong via a
  // real Android device (2026-09-07): Android's telephony stack validates
  // this grammar client-side before ever reaching the network and
  // rejected the single-asterisk form as "invalid MMI code." The
  // single-asterisk form had only ever been confirmed on one iPhone/
  // carrier combination (APP_DECISION_003) — Android was explicitly
  // flagged there as unverified, and this is that verification landing
  // negative.
  const code = `**21*${dialledNumber}#`;

  // Deactivation code — landline vs mobile are handled completely
  // separately, per the carrier audit's Task B finding.
  //
  // Landline: unchanged from before. Deactivation (`#SC#`) and Erasure
  // (`##SC#`) are BOTH valid, standard MMI procedures for service code
  // 21 — unlike the registration code above, there is no invalid-syntax
  // defect here. Left unchanged: no research documents a real reason
  // Virgin needs Erasure specifically rather than Deactivation, but
  // "unresearched" isn't "incorrect," and changing it without a
  // confirmed reason would be a guess, not a fix. This branch never
  // reads `carrier` — landline and mobile provider data are always
  // kept separate.
  //
  // Mobile (iphone/android): the 2026-09-07-era code hardcoded #21# for
  // every mobile network regardless of carrier. The carrier audit
  // (2026-09-10) found this assumption is itself wrong — Vodafone's and
  // SMARTY's own first-party docs show the real "cancel everything" code
  // is ##002# for most networks, #21#/##21# being specific to the
  // unconditional-forwarding *service class* rather than a universal
  // cancel-all, and Sky uses a different code family (#61#) entirely.
  // There is no confirmed code that is safe to show every mobile
  // customer, so there is no fallback default here at all — an unknown
  // or not-yet-confirmed carrier gets an honest "not confirmed, check
  // native settings / contact support" response
  // (getMobileDeactivationInstructions), never a guessed code.
  let cancelCode;
  let cancelCodeMethod;
  let cancelCodeConfidence = null;
  let cancelCodeNote = null;

  if (deviceType === "landline") {
    cancelCode = provider === "virgin" ? "##21#" : "#21#";
    cancelCodeMethod = "mmi";
  } else {
    const deactivation = getMobileDeactivationInstructions(carrier);
    cancelCode = deactivation.code;
    cancelCodeMethod = deactivation.method;
    cancelCodeConfidence = deactivation.confidence;
    cancelCodeNote = deactivation.note;
  }

  // Sky and Virgin both require calling 150 first to add "Call Divert" to
  // the account before the code will work — confirmed via research this
  // engagement (APP_DECISION_003). Every other provider/device type works
  // with the code alone, no preliminary step.
  const requiresPreliminaryCall = deviceType === "landline" && (provider === "sky" || provider === "virgin");

  return {
    code,
    cancelCode,
    cancelCodeMethod,
    cancelCodeConfidence,
    cancelCodeNote,
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
