// Unit tests for the dashboard's protection-status and setup-checklist
// logic in upload.html — the launch-critical fix ensuring a paying
// customer is never told they're "Protected" while their Twilio number
// provisioning is still pending or has failed.
//
// Two pure functions are extracted from the real page markup (between
// TEST-EXTRACT markers) and executed standalone, no browser or DOM
// library required:
//   - computeProtectionState: active/pending/failed, derived only from
//     twilioNumber + twilioProvisioningStatus.
//   - computeSetupChecklist: the 5-item checklist, derived from the same
//     dashboard data plus the self-reported call-forwarding flag.
//
// Run with: node tests/dashboard-status.test.mjs

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

function extractBetween(source, name) {
  const startMarker = `// TEST-EXTRACT-START: ${name}`;
  const endMarker = `// TEST-EXTRACT-END: ${name}`;
  const startIdx = source.indexOf(startMarker);
  const endIdx = source.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    return null;
  }
  return source.slice(startIdx + startMarker.length, endIdx);
}

const protectionStateSource = extractBetween(html, 'computeProtectionState');
const checklistSource = extractBetween(html, 'computeSetupChecklist');
const adminButtonSource = extractBetween(html, 'shouldShowAdminButton');
const progressSource = extractBetween(html, 'computeChecklistProgress');
const memberSinceSource = extractBetween(html, 'formatMemberSince');
const describeCallSource = extractBetween(html, 'describeCall');
const muteStatsSource = extractBetween(html, 'shouldMuteStatsGrid');

if (!protectionStateSource || !checklistSource || !adminButtonSource || !progressSource || !memberSinceSource || !describeCallSource || !muteStatsSource) {
  console.error('✗ could not find one or more expected TEST-EXTRACT markers in upload.html — test cannot run');
  failures++;
} else {
  // Both functions are evaluated together, in the same combined source,
  // since computeSetupChecklist calls computeProtectionState internally
  // — matching how they actually run together in the real page.
  const combinedSource = `${protectionStateSource}\n${checklistSource}\n${adminButtonSource}\n${progressSource}\n${memberSinceSource}\n${describeCallSource}\n${muteStatsSource}\nreturn { computeProtectionState, computeSetupChecklist, shouldShowAdminButton, computeChecklistProgress, formatMemberSince, describeCall, shouldMuteStatsGrid };`;
  const {
    computeProtectionState,
    computeSetupChecklist,
    shouldShowAdminButton,
    computeChecklistProgress,
    shouldMuteStatsGrid,
    formatMemberSince,
    describeCall,
  } = new Function(combinedSource)();

  // --- computeProtectionState ---

  check(
    computeProtectionState({ twilioNumber: '+447700900123', twilioProvisioningStatus: 'active' }) === 'active',
    'active: a real number plus an active provisioning status is the only combination that counts as protected'
  );

  check(
    computeProtectionState({ twilioNumber: null, twilioProvisioningStatus: 'pending' }) === 'pending',
    'pending: no number yet, still pending, is never shown as active'
  );

  check(
    computeProtectionState({ twilioNumber: null, twilioProvisioningStatus: 'failed' }) === 'failed',
    'failed: provisioning failed is reported as failed, not silently treated as pending'
  );

  check(
    computeProtectionState({ twilioNumber: '+447700900123', twilioProvisioningStatus: 'pending' }) === 'pending',
    'a number present but status not yet active is never claimed as protected (guards against a race/inconsistent read)'
  );

  check(
    computeProtectionState({ twilioNumber: null, twilioProvisioningStatus: 'active' }) === 'pending',
    'status says active but no number is present — never claimed as protected; the number is what actually matters'
  );

  check(
    computeProtectionState(null) === 'pending',
    'missing data entirely defaults to pending, never to active'
  );

  check(
    computeProtectionState(undefined) === 'pending',
    'undefined data is handled the same as null, without throwing'
  );

  // --- computeSetupChecklist ---

  const activeData = { twilioNumber: '+447700900123', twilioProvisioningStatus: 'active', contactsUploaded: 3 };

  const checklistAllDone = computeSetupChecklist(activeData, true);
  check(
    checklistAllDone.accountConfirmed === true && checklistAllDone.subscriptionActive === true,
    'account confirmation and subscription-active are always true once dashboard data has loaded at all (both are preconditions for reaching this code)'
  );
  check(checklistAllDone.protectedNumberAssigned === true, 'protected number assigned reflects the active protection state');
  check(checklistAllDone.contactsUploaded === true, 'contacts uploaded is true once at least one contact exists');
  check(checklistAllDone.callForwardingCompleted === true, 'call forwarding reflects the self-reported flag when true');

  const checklistNothingDone = computeSetupChecklist(
    { twilioNumber: null, twilioProvisioningStatus: 'pending', contactsUploaded: 0 },
    false
  );
  check(checklistNothingDone.protectedNumberAssigned === false, 'protected number assigned is false while provisioning is still pending');
  check(checklistNothingDone.contactsUploaded === false, 'contacts uploaded is false with zero contacts');
  check(checklistNothingDone.callForwardingCompleted === false, 'call forwarding reflects the self-reported flag when false');

  const checklistFailedProvisioning = computeSetupChecklist(
    { twilioNumber: null, twilioProvisioningStatus: 'failed', contactsUploaded: 1 },
    false
  );
  check(
    checklistFailedProvisioning.protectedNumberAssigned === false,
    'protected number assigned is false when provisioning has failed, not just when it\'s pending'
  );

  check(
    computeSetupChecklist(null, false).protectedNumberAssigned === false,
    'a checklist computed against missing data never claims the number is assigned'
  );

  // --- shouldShowAdminButton ---

  check(
    shouldShowAdminButton({ isAdmin: true }) === true,
    'shouldShowAdminButton: shows the button when the server reports isAdmin: true'
  );

  check(
    shouldShowAdminButton({ isAdmin: false }) === false,
    'shouldShowAdminButton: hides the button for an ordinary customer (isAdmin: false)'
  );

  check(
    shouldShowAdminButton({}) === false,
    'shouldShowAdminButton: defaults to hidden when isAdmin is missing from the response'
  );

  check(
    shouldShowAdminButton(null) === false,
    'shouldShowAdminButton: defaults to hidden (not throwing) for null/missing data entirely'
  );

  check(
    shouldShowAdminButton({ isAdmin: 'true' }) === false,
    'shouldShowAdminButton: only the exact boolean true shows the button, not a truthy string'
  );

  // --- computeChecklistProgress ---

  check(
    JSON.stringify(computeChecklistProgress({ a: true, b: true, c: false })) === JSON.stringify({ completed: 2, total: 3 }),
    'computeChecklistProgress: counts only truthy entries as completed'
  );

  check(
    JSON.stringify(computeChecklistProgress({})) === JSON.stringify({ completed: 0, total: 0 }),
    'computeChecklistProgress: an empty checklist is 0 of 0, not a division error'
  );

  // --- formatMemberSince ---

  check(formatMemberSince('2026-03-15T10:00:00Z') === 'March 2026', 'formatMemberSince: formats an ISO date as "Month Year"');
  check(formatMemberSince(null) === '—', 'formatMemberSince: renders an em dash, not a fabricated date, when unavailable');
  check(formatMemberSince('not-a-date') === '—', 'formatMemberSince: an unparseable value also renders an em dash rather than "Invalid Date"');

  // --- describeCall ---

  check(
    describeCall({ status: 'Known' }).title === 'Someone you know called',
    'describeCall: a known contact is described in plain English, not "Trusted caller"'
  );

  check(
    describeCall({ status: 'Unknown', result: 'SCAM' }).title === 'We blocked a suspected scam call',
    'describeCall: a blocked scam call names what actually happened'
  );

  check(
    describeCall({ status: 'Unknown', result: 'SAFE' }).title === 'We checked this call and let it through',
    'describeCall: a safe unknown call never mentions "AI" — plain English only'
  );

  // --- shouldMuteStatsGrid ---

  check(
    shouldMuteStatsGrid({ twilioNumber: '+447700900123', twilioProvisioningStatus: 'active' }) === false,
    'shouldMuteStatsGrid: not muted once protection is genuinely active'
  );

  check(
    shouldMuteStatsGrid({ twilioNumber: null, twilioProvisioningStatus: 'pending' }) === true,
    'shouldMuteStatsGrid: muted while protection is still pending, so zeroes read as "nothing has happened yet" not "broken"'
  );

  check(
    shouldMuteStatsGrid({ twilioNumber: null, twilioProvisioningStatus: 'failed' }) === true,
    'shouldMuteStatsGrid: muted when provisioning has failed too'
  );
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
