// Structural tests for the 2026-09-16 follow-up UX fix on the redesigned
// subscribe screen: for a not-currently-supported network/plan
// combination, "Continue" must never remain visible (it implied the
// customer could proceed with the very selection just declared
// unsupported) — replaced by a distinct "Choose a different network or
// plan" action that returns focus to the relevant control without
// resetting the customer's existing selections.
//
// See tests/subscribe-screen-redesign.test.mjs for the rest of the
// redesign's coverage (tiles, consent card, responsive rules, etc.),
// which this file does not duplicate.
//
// Run with: node tests/subscribe-screen-followup.test.mjs

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

const evalFnStart = html.indexOf('async function evaluateCarrierCompatibility() {');
const evalFnEnd = html.indexOf('\n  if (checkCarrierButtonEl) {', evalFnStart);
const evalFnBody = html.slice(evalFnStart, evalFnEnd);

// --- Reset at the top of every attempt ---
check(
  evalFnBody.includes('checkCarrierButtonEl.hidden = false') && evalFnBody.includes('carrierChooseDifferentButtonEl.hidden = true'),
  'every fresh compatibility check starts by restoring Continue and hiding "Choose a different network or plan" — a new attempt is never pre-judged by the previous one\'s outcome'
);

// --- The not-currently-supported branch specifically ---
const notSupportedBranchStart = evalFnBody.lastIndexOf('} else {');
const notSupportedBranchBody = evalFnBody.slice(notSupportedBranchStart);

check(
  notSupportedBranchBody.includes('checkCarrierButtonEl.hidden = true'),
  'Continue is explicitly hidden in the not-currently-supported branch — it is never left on screen next to "this doesn\'t work"'
);
check(
  notSupportedBranchBody.includes('carrierChooseDifferentButtonEl.hidden = false'),
  '"Choose a different network or plan" is explicitly shown in that same branch'
);
check(
  !notSupportedBranchBody.includes('handleCarrierCheckSuccess()'),
  'the not-currently-supported branch never calls handleCarrierCheckSuccess() — Subscribe/Terms never appear alongside this message'
);

// --- needs_confirmation is untouched by this follow-up (out of scope —
//     the instruction was specifically about "unsupported", not the
//     genuinely-unknown case, which keeps its own existing behaviour) ---
const needsConfirmationBranchStart = evalFnBody.indexOf('if (result.customerState === "needs_confirmation")');
const needsConfirmationBranchBody = evalFnBody.slice(needsConfirmationBranchStart, notSupportedBranchStart);
check(
  !needsConfirmationBranchBody.includes('checkCarrierButtonEl.hidden = true') && !needsConfirmationBranchBody.includes('carrierChooseDifferentButtonEl.hidden = false'),
  'needs_confirmation (a genuine unknown, not a confirmed "unsupported") is deliberately left unchanged by this follow-up — only the confirmed not-currently-supported case swaps Continue out'
);

// --- Exact required wording, network-only vs network+plan ---
check(
  html.includes('const isTariffCombo = !!(tariffType && TARIFF_LABELS[tariffType]);'),
  'whether the subtext says "network" alone or "network or plan" is driven by whether a tariff was actually part of what was rejected'
);
check(
  html.includes('? "You can use Home Call Guard with another supported mobile network or plan."') &&
    html.includes(': "You can use Home Call Guard with another supported mobile network."'),
  'both exact required subtext strings are present, selected by isTariffCombo'
);
check(
  html.includes('`Unfortunately, ${subject} is not currently compatible with Home Call Guard.`'),
  'the headline sentence matches the required "Unfortunately, X is not currently compatible with Home Call Guard." pattern exactly'
);

// A household on Tesco Mobile (no tariff dependency at all) must land on
// the "network" wording, not "network or plan" — simulate the exact
// decision the real code makes.
{
  const TARIFF_LABELS = { pay_monthly: 'Pay Monthly', payg: 'Pay As You Go' };
  function composeMessages(networkLabel, tariffType) {
    const isTariffCombo = !!(tariffType && TARIFF_LABELS[tariffType]);
    const subject = isTariffCombo ? `${networkLabel} ${TARIFF_LABELS[tariffType]}` : networkLabel;
    return {
      headline: `Unfortunately, ${subject} is not currently compatible with Home Call Guard.`,
      subtext: isTariffCombo
        ? 'You can use Home Call Guard with another supported mobile network or plan.'
        : 'You can use Home Call Guard with another supported mobile network.',
    };
  }

  const tesco = composeMessages('Tesco Mobile', undefined);
  check(
    tesco.headline === 'Unfortunately, Tesco Mobile is not currently compatible with Home Call Guard.',
    'Tesco Mobile: exact required headline'
  );
  check(
    tesco.subtext === 'You can use Home Call Guard with another supported mobile network.',
    'Tesco Mobile: exact required subtext — "network" only, no "or plan" (Tesco is a pure network rejection, not tariff-specific)'
  );

  const vodafonePayg = composeMessages('Vodafone', 'payg');
  check(
    vodafonePayg.headline === 'Unfortunately, Vodafone Pay As You Go is not currently compatible with Home Call Guard.',
    'Vodafone PAYG: headline includes both the network and the plan'
  );
  check(
    vodafonePayg.subtext === 'You can use Home Call Guard with another supported mobile network or plan.',
    'Vodafone PAYG: exact required subtext — "network or plan", since this rejection is plan-specific'
  );
}

// --- "Choose a different network or plan" click handler ---
const chooseDifferentHandlerStart = html.indexOf('carrierChooseDifferentButtonEl.addEventListener("click"');
check(chooseDifferentHandlerStart !== -1, '"Choose a different network or plan" has a click handler');
const chooseDifferentHandlerEnd = html.indexOf('\n  }', html.indexOf('scrollIntoView', chooseDifferentHandlerStart));
const chooseDifferentHandlerBody = html.slice(chooseDifferentHandlerStart, chooseDifferentHandlerEnd);

check(
  chooseDifferentHandlerBody.includes('carrierNotSupportedMessageEl.hidden = true') &&
    chooseDifferentHandlerBody.includes('checkCarrierButtonEl.hidden = false'),
  'clicking it hides the not-currently-supported message and restores Continue for the next real attempt'
);
check(
  !chooseDifferentHandlerBody.includes('.value = ""') && !chooseDifferentHandlerBody.includes('carrierNetworkSelectEl.value ='),
  'clicking it does NOT reset the network select\'s value — "do not reset more information than necessary" — the customer can see and simply change their existing selection'
);
check(
  !/carrierTariffPayMonthly.*\.checked\s*=\s*false|carrierTariffPayg.*\.checked\s*=\s*false/.test(chooseDifferentHandlerBody),
  'clicking it does NOT uncheck the tariff radios either'
);
check(
  chooseDifferentHandlerBody.includes('.focus()') && chooseDifferentHandlerBody.includes('scrollIntoView'),
  'clicking it returns focus to the relevant network/plan control, satisfying "return the customer to the selection controls"'
);
check(
  chooseDifferentHandlerBody.includes('carrierTariffRowEl && !carrierTariffRowEl.hidden'),
  'focus goes to the tariff tiles specifically when a tariff row is the thing currently in play, otherwise to the network select'
);

// --- No technical reason ever shown on this screen (re-confirmed after
//     the follow-up edit, in case the composition logic moved) ---
check(
  !/result\.reason(?!\s*===\s*"tariff_type_required")/.test(evalFnBody.replace(/result\.reason\s*===\s*"tariff_type_required"/g, '')),
  'no code path in evaluateCarrierCompatibility ever reads/displays the backend\'s raw `reason` string to the customer, other than the internal "tariff_type_required" sentinel check'
);

// --- Regression: an author `display` declaration on a class applied
//     directly to an element toggled via the native `hidden` attribute
//     silently defeats the hide/show toggle (this file's own
//     .protected-number comment documents the same gotcha having bitten
//     this codebase before — found again here via a real visual check
//     of the "Choose a different network or plan" state, where
//     Continue stayed visible instead of hiding). Both buttons this
//     follow-up added are toggled directly on themselves via `hidden`,
//     so neither of their classes may declare `display` at all. ---
function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

{
  const primaryRuleStart = html.indexOf('.signup-primary-button {');
  const primaryRuleEnd = html.indexOf('\n  }', primaryRuleStart);
  const primaryRule = stripCssComments(html.slice(primaryRuleStart, primaryRuleEnd));
  check(
    !/display\s*:/.test(primaryRule),
    '.signup-primary-button declares no `display` override (outside its own explanatory comment) — #checkCarrierButton\'s native `hidden` toggle actually works'
  );

  const chooseDifferentRuleStart = html.indexOf('.signup-choose-different-button {');
  const chooseDifferentRuleEnd = html.indexOf('\n  }', chooseDifferentRuleStart);
  const chooseDifferentRule = stripCssComments(html.slice(chooseDifferentRuleStart, chooseDifferentRuleEnd));
  check(
    !/display\s*:/.test(chooseDifferentRule),
    '.signup-choose-different-button declares no `display` override either — its native `hidden` toggle also actually works'
  );
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
