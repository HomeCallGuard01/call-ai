// Unit tests for services/providerPolicy.js — P0 Batch 1, component A.
// Pure functions, no network/DB involved. Covers the exact scenario list
// from this batch's instruction: compatible / incompatible /
// provider-specific / unknown-unverified carriers, the PAYG/Pay Monthly
// distinction, and "no universal fallback" for deactivation guidance.
//
// Run with: node tests/provider-policy.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  getProviderPolicy,
  evaluateProviderCompatibility,
  getMobileDeactivationInstructions,
  evaluateHouseholdCheckoutEligibility,
  PROVIDER_POLICY,
} = require('../services/providerPolicy.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- compatible carrier ---

{
  const result = evaluateProviderCompatibility('o2');
  check(result.status === 'compatible', 'O2: status is compatible');
  check(result.canProceedToPayment === true, 'O2: may proceed to payment');
}

{
  const result = evaluateProviderCompatibility('giffgaff');
  check(result.status === 'compatible', 'giffgaff: status is compatible');
  check(result.canProceedToPayment === true, 'giffgaff: may proceed to payment');
}

// --- incompatible carrier ---

{
  const result = evaluateProviderCompatibility('tesco');
  check(result.status === 'incompatible', 'Tesco Mobile: status is incompatible');
  check(result.canProceedToPayment === false, 'Tesco Mobile: must NOT proceed to payment — real customer harm was already observed here');
  check(typeof result.reason === 'string' && result.reason.length > 0, 'Tesco Mobile: a human-readable reason is provided');
}

{
  const result = evaluateProviderCompatibility('1pmobile');
  check(result.status === 'incompatible' && result.canProceedToPayment === false, '1pMobile: incompatible, blocked before payment (voicemail-only diversion)');
}

// Lyca moved from the "incompatible" block above to here deliberately —
// see "evidence discipline" section below.

// --- provider-specific carrier ---

{
  const result = evaluateProviderCompatibility('three');
  check(result.status === 'provider_specific', 'Three: status is provider_specific');
  check(result.canProceedToPayment === true, 'Three: may proceed to payment (provider_specific proceeds, per the corrected two-way gate)');
  check(result.policy.method === 'native_settings', 'Three: method is native_settings, not mmi — MMI is reportedly broken network-wide');
}

{
  const result = evaluateProviderCompatibility('sky');
  check(result.status === 'provider_specific' && result.canProceedToPayment === true, 'Sky Mobile: provider_specific, may proceed');
}

// --- unknown/unverified carrier — MUST stop before payment, never proceed with only a warning ---

{
  const result = evaluateProviderCompatibility('voxi');
  check(result.status === 'unverified', 'VOXI: status is unverified');
  check(result.canProceedToPayment === false, 'VOXI: must NOT proceed to payment — this is the explicit correction: unverified never proceeds merely with a warning');
}

{
  const result = evaluateProviderCompatibility('lebara');
  check(result.status === 'unverified' && result.canProceedToPayment === false, 'Lebara: unverified, blocked before payment');
}

{
  const result = evaluateProviderCompatibility('some-network-never-heard-of');
  check(result.status === 'unverified', 'a completely unrecognised provider key falls back to unverified, never silently treated as compatible');
  check(result.canProceedToPayment === false, 'an unrecognised provider key is blocked before payment');
}

{
  const result = evaluateProviderCompatibility(undefined);
  check(result.status === 'unverified' && result.canProceedToPayment === false, 'no carrier supplied at all is treated as unverified, blocked before payment — never assumed compatible by omission');
}

// --- PAYG / Pay Monthly distinction (Vodafone) ---

{
  const result = evaluateProviderCompatibility('vodafone', 'pay_monthly');
  check(result.status === 'compatible' && result.canProceedToPayment === true, 'Vodafone Pay Monthly: compatible, may proceed');
}

{
  const result = evaluateProviderCompatibility('vodafone', 'payg');
  check(result.status === 'incompatible', 'Vodafone PAYG: status becomes incompatible — PAYG structurally has no forwarding');
  check(result.canProceedToPayment === false, 'Vodafone PAYG: must NOT proceed to payment');
}

{
  // tariff genuinely required but not supplied — must not default to
  // assuming the compatible (Pay Monthly) case.
  const result = evaluateProviderCompatibility('vodafone');
  check(result.status === 'unverified', 'Vodafone with no tariff supplied: treated as unverified, not assumed Pay Monthly');
  check(result.canProceedToPayment === false, 'Vodafone with no tariff supplied: must NOT proceed to payment until tariff is known');
  check(result.reason === 'tariff_type_required', 'the reason clearly names what is missing (tariff_type_required)');
}

{
  const result = evaluateProviderCompatibility('vodafone', 'not-a-real-tariff');
  check(result.status === 'unverified' && result.canProceedToPayment === false, 'an invalid tariff value is treated the same as missing — never silently coerced to a real tariff');
}

{
  // A provider without a tariff dependency ignores tariffType entirely —
  // must not be blocked just because it wasn't supplied.
  const result = evaluateProviderCompatibility('o2', undefined);
  check(result.status === 'compatible' && result.canProceedToPayment === true, 'a tariff-independent provider (O2) is unaffected by an omitted tariffType');
}

// --- correct provider-specific deactivation instruction ---

{
  const result = getMobileDeactivationInstructions('vodafone');
  check(result.method === 'mmi' && result.code === '##002#', 'Vodafone: deactivation code is the first-party-confirmed ##002#');
}

{
  const result = getMobileDeactivationInstructions('sky');
  check(result.method === 'mmi' && result.code === '#61#', "Sky Mobile: deactivation code is #61# — a different service-code family entirely, not #21#/##21#");
}

{
  const result = getMobileDeactivationInstructions('smarty');
  check(result.code === '#002#', 'SMARTY: deactivation code matches the first-party-confirmed #002# (cancel-all-and-forget)');
}

// --- no universal ##21#/#21# fallback ---

{
  const result = getMobileDeactivationInstructions('three');
  check(result.method === 'native_settings', 'Three: method is native_settings, not an MMI code');
  check(result.code === null, 'Three: no MMI code is fabricated for a network where MMI is reportedly broken');
}

{
  const result = getMobileDeactivationInstructions('talkmobile');
  check(result.code === null, 'Talkmobile: no deactivation code is fabricated where none was confirmed by the audit');
  check(result.method === 'unknown', 'Talkmobile: method is honestly reported as unknown, not defaulted to mmi');
}

{
  // The core regression case: an unknown/not-yet-captured carrier (every
  // real customer today, since carrier capture does not exist yet) must
  // never receive the old hardcoded #21# value.
  const result = getMobileDeactivationInstructions(undefined);
  check(result.code === null, 'no carrier at all: no code is fabricated');
  check(result.code !== '#21#' && result.code !== '##21#', 'no carrier at all: never falls back to the old, confirmed-wrong universal #21#/##21# value');
  check(typeof result.note === 'string' && result.note.length > 0, 'no carrier at all: an honest explanatory note is still provided');
}

{
  const other = getMobileDeactivationInstructions('other');
  check(other.code === null && other.code !== '#21#', "'other': never falls back to the old universal code either");
}

// --- evidence discipline (re-check, 2026-09-10) ---
//
// A prior version of this file shipped exact deactivation codes for
// giffgaff and EE, and a definitive "incompatible" classification for
// Lyca, that overstated what the underlying audit evidence actually
// supports. Re-checked against the original audit matrix and corrected:
// unconfirmed/secondary-only evidence must never be promoted to a
// confident production rule.

{
  // giffgaff: compatibility itself is well-evidenced (own shortcode
  // article + a real physical-device confirmation), but the audit
  // reported TWO candidate deactivation codes (#21# and ##002#) with no
  // first-party source resolving which one is actually correct for
  // giffgaff specifically — shipping either one as "the" code would be a
  // guess, not a confirmed fact.
  const result = getMobileDeactivationInstructions('giffgaff');
  check(result.code === null, 'giffgaff: no deactivation code is shipped — two unresolved candidate codes (#21#/##002#) is not the same as a confirmed one');
  check(evaluateProviderCompatibility('giffgaff').status === 'compatible', 'giffgaff: compatibility itself is unaffected — only the unconfirmed deactivation code was corrected');
}

{
  // EE: the original audit's own "Unknowns requiring physical testing"
  // section explicitly lists EE's exact deactivation code as never
  // re-verified from a first-party source — it was only a cross-provider
  // pattern inference (O2/Vodafone/SMARTY all use ##002#), which is not
  // the same thing as a confirmed fact for EE itself.
  const result = getMobileDeactivationInstructions('ee');
  check(result.code === null, 'EE: no deactivation code is shipped — a cross-provider pattern inference is not a first-party-confirmed fact for EE specifically');
  check(evaluateProviderCompatibility('ee').status === 'provider_specific', 'EE: compatibility classification itself is unaffected');
}

{
  // Lyca: the "no forwarding" conclusion rests on multiple secondary
  // sources and one matching real user failure report — genuinely
  // suggestive, but not an official/first-party Lyca statement, unlike
  // Tesco Mobile's and 1pMobile's actual incompatible classifications
  // (both backed by an official support statement/help page). Downgraded
  // to 'unverified' so the customer-facing reason is honest about the
  // real confidence level.
  const result = evaluateProviderCompatibility('lyca');
  check(result.status === 'unverified', 'Lyca Mobile: downgraded from a confident "incompatible" claim to "unverified" — the underlying evidence is secondary-sourced, not an official Lyca statement');
  check(result.canProceedToPayment === false, 'Lyca Mobile: still blocked before payment — the payment-gate OUTCOME is unaffected by this correction (unverified blocks exactly like incompatible does), only the honesty of the stated reason changes');
}

{
  // Contrast: Tesco Mobile and 1pMobile genuinely ARE backed by an
  // official first-party statement each — these remain "incompatible",
  // not "unverified", because the evidence standard is actually met here.
  check(evaluateProviderCompatibility('tesco').status === 'incompatible', 'Tesco Mobile: remains a confident "incompatible" — backed by an official Tesco Mobile support statement, unlike Lyca');
  check(evaluateProviderCompatibility('1pmobile').status === 'incompatible', "1pMobile: remains a confident 'incompatible' — backed by 1pMobile's own official help page, unlike Lyca");
}

// --- policy data integrity ---

{
  const keys = Object.keys(PROVIDER_POLICY);
  check(keys.length > 0, 'PROVIDER_POLICY is non-empty');
  for (const key of keys) {
    const entry = PROVIDER_POLICY[key];
    check(
      ['compatible', 'provider_specific', 'incompatible', 'unverified'].includes(entry.status),
      `${key}: status is one of the four defined values`
    );
    if (entry.status === 'incompatible' || entry.status === 'unverified') {
      check(!entry.deactivationCode, `${key} (${entry.status}): never carries a deactivation code — there is nothing to deactivate on a network that isn't compatible`);
    }
  }
}

// --- evaluateHouseholdCheckoutEligibility (P0 Batch 1 continuation:
// wiring the gate into checkout, 2026-09-11) ---

{
  const result = evaluateHouseholdCheckoutEligibility({ carrier_provider_key: 'o2' });
  check(result.status === 'compatible', 'household on O2: status is compatible');
  check(result.canProceedToPayment === true, 'household on O2: may proceed to checkout');
}

{
  const result = evaluateHouseholdCheckoutEligibility({ carrier_provider_key: 'tesco' });
  check(result.status === 'incompatible', 'household on Tesco: status is incompatible');
  check(result.canProceedToPayment === false, 'household on Tesco: checkout is blocked');
}

{
  const result = evaluateHouseholdCheckoutEligibility({ carrier_provider_key: 'vodafone', carrier_tariff_type: 'payg' });
  check(result.status === 'incompatible', 'household on Vodafone PAYG: status is incompatible (existing tariff-dependent policy preserved)');
  check(result.canProceedToPayment === false, 'household on Vodafone PAYG: checkout is blocked');
}

{
  const result = evaluateHouseholdCheckoutEligibility({ carrier_provider_key: 'vodafone', carrier_tariff_type: 'pay_monthly' });
  check(result.canProceedToPayment === true, 'household on Vodafone Pay Monthly: checkout is allowed (tariff-dependent policy still applies correctly)');
}

{
  const result = evaluateHouseholdCheckoutEligibility({ carrier_provider_key: 'some_unknown_mvno_xyz' });
  check(result.status === 'unverified', 'household on an unrecognised carrier: status is unverified');
  check(result.canProceedToPayment === false, 'household on an unrecognised carrier: checkout is blocked, never treated as compatible by default');
}

{
  const result = evaluateHouseholdCheckoutEligibility({});
  check(result.canProceedToPayment === false, 'household with no carrier captured yet: checkout is blocked, not silently allowed through');
}

{
  const result = evaluateHouseholdCheckoutEligibility(null);
  check(result.canProceedToPayment === false, 'evaluateHouseholdCheckoutEligibility never throws on a null household — fails closed');
}

{
  const result = evaluateHouseholdCheckoutEligibility(undefined);
  check(result.canProceedToPayment === false, 'evaluateHouseholdCheckoutEligibility never throws on an undefined household — fails closed');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
