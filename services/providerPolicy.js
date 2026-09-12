// V1 UK mobile-network compatibility/deactivation policy — versioned code
// config, not a database table (P0 Batch 1 scope reduction: an
// admin-editable DB-backed policy table is deferred; this module mirrors
// the existing static-reference-data pattern already used by
// services/activationInstructions.js's LANDLINE_PROVIDERS).
//
// Every fact below is sourced directly from this engagement's UK carrier
// compatibility/deactivation-code audit (2026-09-10) — no code or status
// is invented. Where the audit could not confirm a fact (no first-party
// or multiply-corroborated source), the corresponding field is left null
// and the provider's status is "unverified" rather than guessed. See each
// entry's `source` field for the exact citation and `confidence` for how
// strong that citation is.
//
// Two-way compatibility gate only (no three-way "proceed with a warning"
// state) — an explicit correction to an earlier draft of this design:
// only 'compatible' and 'provider_specific' may proceed to payment.
// 'incompatible' and 'unverified' (including any provider not in this
// list) must both stop BEFORE payment — an unverified network is not
// treated as probably-fine-with-a-caveat, because the harm of a customer
// paying for a network that then cannot forward calls has already been
// observed for real (Tesco Mobile). See evaluateProviderCompatibility.

const PROVIDER_POLICY_VERSION = "2026-09-10-v1";

// status:
//   'compatible'        — forwarding confirmed to work, no known caveats
//                          beyond an optional tariff restriction
//   'provider_specific'  — forwarding works but needs a non-default
//                          method (native Settings instead of MMI) and/or
//                          has a real documented failure mode
//   'incompatible'       — forwarding confirmed NOT to work (official/
//                          first-party statement)
//   'unverified'         — genuinely not established either way; never
//                          treated as compatible
//
// method: 'mmi' | 'native_settings' | null (null only when status is
//   'incompatible' or 'unverified' — there is no method to describe)
//
// deactivationCode: the exact MMI code to remove forwarding, or null when
//   not confirmed by any source found in the audit (never fabricated)
// deactivationConfidence: 'high' | 'medium' | null
// deactivationSource: short citation, for traceability back to the audit
const PROVIDER_POLICY = {
  o2: {
    status: "compatible",
    method: "mmi",
    deactivationCode: "##002#",
    deactivationConfidence: "medium",
    deactivationSource:
      "o2.co.uk (first-party, activation); O2 Community (deactivation) — some users report ##002# failing when Wi-Fi Calling is active",
  },
  vodafone: {
    status: "compatible",
    method: "mmi",
    tariffDependent: true,
    incompatibleTariff: "payg",
    deactivationCode: "##002#",
    deactivationConfidence: "high",
    deactivationSource: "vodafone.co.uk/help (first-party, both directions)",
  },
  // giffgaff's COMPATIBILITY (forwarding works at all) is well-established
  // — giffgaff's own shortcode article plus a real physical-device
  // confirmation. Its DEACTIVATION code is a separate question the audit
  // did not resolve: two candidate codes (#21# and ##002#) were both
  // reported with no first-party source confirming which one actually
  // cancels forwarding for giffgaff specifically — re-checked 2026-09-10
  // and deliberately left unresolved here rather than picking one, per
  // "unknown evidence must remain unverified, not promoted to a
  // confident production rule."
  giffgaff: {
    status: "compatible",
    method: "mmi",
    deactivationCode: null,
    deactivationConfidence: null,
    deactivationSource:
      "two candidate codes reported (#21# and ##002#), neither first-party-confirmed for giffgaff specifically — genuinely unresolved, not guessed",
  },
  // EE's deactivation code was originally shipped as ##002# at "medium"
  // confidence on a cross-provider pattern-inference basis (O2/Vodafone/
  // SMARTY all confirmed ##002#). Re-checked 2026-09-10: the audit's own
  // "Unknowns requiring physical testing" section explicitly lists EE's
  // exact deactivation code as one it never re-verified from a
  // first-party source — a pattern inference is not the same thing as a
  // confirmed fact, so this is nulled out rather than shipped as a
  // specific code. Compatibility itself (provider_specific) is
  // unaffected — this only changes what cancellation copy is shown.
  ee: {
    status: "provider_specific",
    method: "mmi",
    deactivationCode: null,
    deactivationConfidence: null,
    deactivationSource:
      "pattern-consistent with Vodafone/SMARTY/O2's confirmed ##002#, but never independently first-party confirmed for EE — the audit's own stated open unknown, not shipped as a specific code",
  },
  three: {
    status: "provider_specific",
    method: "native_settings",
    deactivationCode: null,
    deactivationConfidence: null,
    deactivationSource:
      "MMI reportedly broken network-wide (Three Community, multiply corroborated) — native Settings required for both activation and deactivation",
  },
  sky: {
    status: "provider_specific",
    method: "mmi",
    deactivationCode: "#61#",
    deactivationConfidence: "medium",
    deactivationSource: "Sky Community forum (semi-official) — a different service code entirely, not 21",
  },
  smarty: {
    status: "provider_specific",
    method: "mmi",
    deactivationCode: "#002#",
    deactivationConfidence: "high",
    deactivationSource: "help.smarty.co.uk (first-party, fetched directly)",
  },
  id_mobile: {
    status: "provider_specific",
    method: "mmi",
    deactivationCode: "##002#",
    deactivationConfidence: "high",
    deactivationSource:
      "community.idmobile.co.uk, staff-authored reply (first-party) — documented escalation to Live Chat if this fails",
  },
  talkmobile: {
    status: "provider_specific",
    method: "mmi",
    deactivationCode: null,
    deactivationConfidence: null,
    deactivationSource: "no source found for a deactivation code — genuinely unverified, not guessed",
  },
  tesco: {
    status: "incompatible",
    method: null,
    reason: "No network-level call forwarding (official Tesco Mobile support account, direct statement)",
  },
  "1pmobile": {
    status: "incompatible",
    method: null,
    reason: "Voicemail-only diversion, no true call forwarding (1pMobile's own \"Ask Penny\" help page)",
  },
  // Re-checked 2026-09-10: originally shipped as "incompatible" (a
  // confident, definitive claim), but the underlying evidence is
  // secondary-sourced (multiple community reports + one matching real
  // user failure report) — genuinely suggestive, but NOT an official/
  // first-party Lyca statement, unlike Tesco Mobile's and 1pMobile's
  // actual "incompatible" entries below, which are. Downgraded to
  // "unverified" so the customer-facing message is honest about the
  // actual confidence level, rather than stating a fact that hasn't
  // been officially confirmed. The payment gate itself is unaffected —
  // 'unverified' blocks payment exactly like 'incompatible' does, per
  // this file's two-way gate — this correction only changes the
  // customer-facing reason text from a false-confidence claim to an
  // honest one.
  lyca: {
    status: "unverified",
    method: null,
    reason: "Multiple secondary sources and one matching real user failure report suggest no forwarding is available, but this is not confirmed by an official Lyca statement",
  },
  voxi: {
    status: "unverified",
    method: null,
    reason:
      "VOXI's own support account disclaims providing forwarding (\"set up on your device... or give your manufacturer a shout\") — leaning incompatible but not confirmed either way",
  },
  lebara: {
    status: "unverified",
    method: null,
    reason: "Conflicting secondary sources; Lebara's own device-help page exists but direct fetch was blocked (HTTP 403)",
  },
  other: {
    status: "unverified",
    method: null,
    reason: "Provider not in HomeCallGuard's confirmed compatibility list",
  },
};

const TARIFF_TYPES = new Set(["pay_monthly", "payg"]);

function getProviderPolicy(providerKey) {
  const key = typeof providerKey === "string" ? providerKey.toLowerCase() : "";
  return PROVIDER_POLICY[key] || PROVIDER_POLICY.other;
}

// Pure. The single source of truth for "may this household proceed to
// payment" — see this file's header for why the gate is two-way
// (proceed / stop), never a three-way "proceed with a warning" for an
// unverified network.
//
// tariffType is required whenever the resolved provider is
// tariffDependent (currently only Vodafone: PAYG has no forwarding at
// all). Omitting it when required is treated the same as an unverified
// provider — stopped, not assumed compatible — since the answer is
// genuinely unknown until asked.
function evaluateProviderCompatibility(providerKey, tariffType) {
  const policy = getProviderPolicy(providerKey);

  if (policy.status === "compatible" && policy.tariffDependent) {
    if (!tariffType || !TARIFF_TYPES.has(tariffType)) {
      return {
        status: "unverified",
        canProceedToPayment: false,
        reason: "tariff_type_required",
        policy,
      };
    }
    if (tariffType === policy.incompatibleTariff) {
      return {
        status: "incompatible",
        canProceedToPayment: false,
        reason: `${providerKey} ${tariffType} does not support call forwarding`,
        policy,
      };
    }
  }

  const canProceedToPayment = policy.status === "compatible" || policy.status === "provider_specific";

  return {
    status: policy.status,
    canProceedToPayment,
    reason: policy.reason || null,
    policy,
  };
}

// Pure. Returns the correct provider-specific mobile-deactivation
// guidance — never a universal fallback code. carrier may be null/
// undefined (an existing customer with no stored carrier, or any
// provider this policy doesn't have a confirmed code for); in every case
// where a code isn't confirmed, `code` is null and `method` honestly
// reflects what's known, rather than defaulting to any single MMI code.
function getMobileDeactivationInstructions(providerKey) {
  const policy = getProviderPolicy(providerKey);

  if (policy.method === "native_settings") {
    return {
      method: "native_settings",
      code: null,
      confidence: null,
      note:
        policy.deactivationSource ||
        "Use your phone's native call forwarding settings (Phone app settings, or Settings > Phone/Calls) — an MMI code is not reliable on this network.",
    };
  }

  if (!policy.deactivationCode) {
    return {
      method: "unknown",
      code: null,
      confidence: null,
      note:
        "We don't have a confirmed call-forwarding removal code for your network yet. Check your phone's native call forwarding settings, or contact support for help.",
    };
  }

  return {
    method: "mmi",
    code: policy.deactivationCode,
    confidence: policy.deactivationConfidence,
    note: policy.deactivationSource,
  };
}

// P0 Batch 1 continuation (2026-09-11): the missing "before payment" half
// of this file — evaluateProviderCompatibility above existed already,
// fully tested, but had zero callers anywhere in the app (see the
// carrier-compatibility audit). This is the one function both checkout
// routes (routes/billing.js, routes/mobileApi.js) call to decide whether
// Stripe Checkout may even be started.
//
// Takes a household-shaped object rather than a bare provider string, so
// callers never have to know which two household columns this depends on
// (supabase/migrations/038_household_carrier_compatibility.sql). A
// household with no carrier captured yet — every household that existed
// before this migration, or one that hasn't reached the onboarding
// carrier step yet — has carrier_provider_key === null/undefined, which
// getProviderPolicy resolves to PROVIDER_POLICY.other: 'unverified',
// blocked. There is no separate "no data yet" case to special-case here;
// it is already handled correctly by the exact same fallback an
// unrecognised provider string gets. Never throws — a null/undefined
// household argument resolves the same way.
function evaluateHouseholdCheckoutEligibility(household) {
  return evaluateProviderCompatibility(
    household && household.carrier_provider_key,
    household && household.carrier_tariff_type
  );
}

module.exports = {
  PROVIDER_POLICY_VERSION,
  PROVIDER_POLICY,
  TARIFF_TYPES,
  getProviderPolicy,
  evaluateProviderCompatibility,
  getMobileDeactivationInstructions,
  evaluateHouseholdCheckoutEligibility,
};
