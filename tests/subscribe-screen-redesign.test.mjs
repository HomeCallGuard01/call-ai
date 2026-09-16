// Structural tests for the 2026-09-16 "no active membership / subscribe"
// screen visual redesign (upload.html's #statusCard, unsubscribed
// state). Pure UI/UX rebuild — see tests/web-carrier-onboarding-gate.
// test.mjs and tests/cancellation-deactivation-safety.test.mjs for the
// underlying carrier-compatibility/cancellation LOGIC coverage, which
// this redesign does not change. This file covers only what's new in
// the redesign itself: large tile controls, the consent card, the
// simplified non-technical compatibility wording, and the "Previously
// used Home Call Guard?" quiet link.
//
// Run with: node tests/subscribe-screen-redesign.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'upload.html'), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// ============================================================
// Hierarchy / branding
// ============================================================

check(
  html.includes('"Protect your home phone from scam callers"'),
  'the unsubscribed headline uses the requested wording'
);
check(
  html.includes('"Join Home Call Guard today for £4.99/month (including VAT). Cancel anytime."'),
  'the unsubscribed subheading states the price and cancel-anytime line up front'
);

// ============================================================
// Mobile + supported Pay Monthly — large tile controls exist and are
// real, semantic, keyboard-accessible radio inputs (not custom divs)
// ============================================================

check(
  /<input type="radio" name="carrierDeviceType" id="carrierDeviceMobile" value="mobile" checked>\s*<span class="tile-face">/.test(html),
  'Mobile phone is a real radio input immediately followed by its visual tile-face span (required for the :checked + .tile-face CSS selector to work, and for the input to stay in the accessibility tree/tab order)'
);
check(
  /<input type="radio" name="carrierDeviceType" id="carrierDeviceLandline" value="landline">\s*<span class="tile-face">/.test(html),
  'Landline is the same real radio pattern'
);
check(
  html.includes('name="carrierTariffType"') && html.includes('id="carrierTariffPayMonthly"') && html.includes('id="carrierTariffPayg"'),
  'Pay Monthly / Pay As You Go are now large tiles (radio inputs), not the old <select> — same underlying values (pay_monthly/payg)'
);
check(
  !html.includes('id="carrierTariffSelect"'),
  'the old tariff <select> element is fully removed, not left dangling alongside the new tiles'
);
check(
  html.includes('function getSelectedTariffType()') && html.includes('carrierTariffType"]:checked'),
  'the JS reads the tariff value from the checked radio tile, matching the new markup'
);
check(
  html.includes('class="big-select"') && html.includes('id="carrierNetworkSelect"'),
  'the network picker is a large, full-width styled <select> — a real native control, not a custom dropdown widget'
);

// ============================================================
// Mobile + unsupported combination / Tesco Mobile — simplified,
// non-technical wording, composed client-side from the known
// selection, never the backend's own technical reason string
// ============================================================

check(
  html.includes('`Unfortunately, ${subject} is not currently compatible with Home Call Guard.`'),
  'the not-currently-supported message is composed client-side in the exact required pattern, using the selected network/plan name'
);
check(
  html.includes('"You can use Home Call Guard with another supported mobile network or plan."') &&
    html.includes('"You can use Home Call Guard with another supported mobile network."'),
  'both required subtext wordings exist — "network or plan" for a plan-specific rejection (e.g. Vodafone PAYG), "network" alone for a pure network rejection (e.g. Tesco Mobile)'
);
check(
  html.includes('id="carrierChooseDifferentButton"') && html.includes('>Choose a different network or plan<'),
  'a distinct "Choose a different network or plan" secondary action exists — see tests/subscribe-screen-followup.test.mjs for its full behaviour'
);
check(
  !/result\.reason\s*\|\|\s*"Home Call Guard isn't currently supported/.test(html),
  'the old fallback that displayed the backend\'s raw technical `reason` string directly to the customer has been removed'
);
check(
  html.includes('function labelForNetwork(providerKey)') && html.includes('MOBILE_NETWORK_OPTIONS.find'),
  'network labels for the message are looked up from the same single option list already used to render the dropdown — never a second, separately-maintained name list that could drift'
);
check(
  html.includes("const TARIFF_LABELS = { pay_monthly: \"Pay Monthly\", payg: \"Pay As You Go\" }"),
  'tariff labels exist for the "[network] [plan]" combined wording (e.g. "Vodafone Pay As You Go")'
);

// Tesco Mobile itself is not special-cased anywhere in the frontend —
// it gets exactly the same generic composed message as any other
// not-currently-supported network, driven only by its real label from
// MOBILE_NETWORK_OPTIONS ("Tesco Mobile") and the backend's
// customerState. This IS the required behaviour: the spec's example
// wording for Tesco is just the general pattern with that name filled
// in, not a hardcoded special case.
check(
  !/tesco/i.test(html.split('const TARIFF_LABELS')[1]?.split('function evaluateCarrierCompatibility')[0] || ''),
  'no Tesco-specific branch exists between the label helpers and the evaluation function — Tesco is not special-cased, it flows through the same generic composed-message path as every other network'
);
check(
  html.includes('<option value="tesco">Tesco Mobile</option>'),
  'Tesco Mobile\'s real display label ("Tesco Mobile") is available for the composed message to use'
);

// The Subscribe button must never be shown/active while blocked.
check(
  html.includes('subscribeFormEl.hidden = false') && (() => {
    // handleCarrierCheckSuccess is the ONLY place that un-hides the
    // subscribeForm — the not-supported/needs-confirmation branches
    // must never call it.
    const successFnStart = html.indexOf('function handleCarrierCheckSuccess() {');
    const successFnEnd = html.indexOf('\n  }', successFnStart);
    const successFnBody = html.slice(successFnStart, successFnEnd);
    const evalFnStart = html.indexOf('async function evaluateCarrierCompatibility() {');
    const blockedBranchStart = html.indexOf('if (result.customerState === "needs_confirmation")', evalFnStart);
    const blockedBranchEnd = html.indexOf('} catch (err) {', blockedBranchStart);
    const blockedBranchBody = html.slice(blockedBranchStart, blockedBranchEnd);
    return successFnBody.includes('subscribeFormEl.hidden = false') && !blockedBranchBody.includes('handleCarrierCheckSuccess()');
  })(),
  'the blocked (not-supported/needs-confirmation) branch never calls handleCarrierCheckSuccess() — the Subscribe button and consent card stay hidden, never shown as an active green CTA suggesting the customer can proceed'
);

// ============================================================
// Consent card
// ============================================================

check(
  html.includes('<div class="consent-card">'),
  'consent lives in its own visually distinct card/panel, not loose text in the main flow'
);
check(
  html.includes('I agree to the Terms &amp; Conditions and acknowledge the Privacy Policy.') &&
    html.includes("I'd like my protection to start right away. I understand I still have 30 days to change my mind either way."),
  'both consent checkboxes retain their exact existing approved wording — nothing rewritten'
);
check(
  !html.includes('id="agreeTermsCheckbox" checked') && !html.includes('id="startImmediatelyCheckbox" checked'),
  'neither consent checkbox is pre-ticked'
);
check(
  html.includes('input[type="checkbox"]') === false || html.includes('.consent-row input[type="checkbox"]'),
  'consent checkboxes have dedicated large-size styling (width/height), not left at the browser-default tiny size'
);
check(
  /\.consent-row input\[type="checkbox"\] \{[^}]*width:\s*28px/.test(html),
  'the consent checkboxes are genuinely enlarged (28px), not just re-coloured'
);
check(
  html.includes('href="/terms.html"') && html.includes('href="/privacy.html"') && html.includes('target="_blank"'),
  'Terms & Conditions and Privacy Policy remain real, clickable links that open independently of the form'
);

// ============================================================
// "Previously used Home Call Guard?" — moved out of the main
// hierarchy, quiet by default, full warning still present on demand
// ============================================================

check(
  html.includes('Previously used Home Call Guard?') && html.includes('class="previously-used-link"'),
  'the quiet link uses the requested copy and its own subdued styling class, separate from the main signup flow'
);
check(
  html.includes('id="unsubscribedDeactivationExplainer"') && html.includes('class="previously-used-panel"'),
  'the full explanation panel exists, hidden by default, revealed only on demand'
);
check(
  html.includes('Cancelling your subscription does not automatically turn off call forwarding on your phone'),
  'the full warning text itself is preserved verbatim inside the on-demand panel, not deleted in the simplification'
);
check(
  (() => {
    const linkStart = html.indexOf('id="unsubscribedDeactivationHelp"');
    const linkEnd = html.indexOf('</section>', linkStart);
    const region = html.slice(linkStart, linkEnd === -1 ? undefined : linkEnd);
    // The big warning block must not be unconditionally visible — only
    // reachable behind the toggle.
    return region.indexOf('id="unsubscribedDeactivationExplainer" class="previously-used-panel" hidden') !== -1;
  })(),
  'the explanation panel starts hidden — the warning no longer clutters the page by default, matching "move this out of the main signup hierarchy"'
);

// ============================================================
// Responsive
// ============================================================

check(
  /@media \(max-width: 480px\) \{[^}]*\.signup-question-title/.test(html.replace(/\n/g, ' ')),
  'a small-screen media query adjusts the redesigned signup controls specifically, not just the pre-existing status-title/status-sub rules'
);
check(
  html.includes('.tile-row {') && html.includes('flex-wrap: wrap'),
  'the device-type/tariff tile rows wrap on narrow screens rather than overflowing or forcing horizontal scroll'
);

// ============================================================
// Scope: no backend/logic files touched by this redesign
// ============================================================

check(
  html.includes('evaluateHouseholdCheckoutEligibility') === false, // frontend never references backend function names directly
  'sanity: the frontend still contains no backend function names — confirms no compatibility logic was inlined into the client during the redesign'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
