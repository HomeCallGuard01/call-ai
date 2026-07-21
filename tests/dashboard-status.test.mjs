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

if (!protectionStateSource || !checklistSource) {
  console.error('✗ could not find computeProtectionState/computeSetupChecklist markers in upload.html — test cannot run');
  failures++;
} else {
  // Both functions are evaluated together, in the same combined source,
  // since computeSetupChecklist calls computeProtectionState internally
  // — matching how they actually run together in the real page.
  const combinedSource = `${protectionStateSource}\n${checklistSource}\nreturn { computeProtectionState, computeSetupChecklist };`;
  const { computeProtectionState, computeSetupChecklist } = new Function(combinedSource)();

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
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
