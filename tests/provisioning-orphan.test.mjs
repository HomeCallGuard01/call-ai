// Number purchase whose DB assignment throws — integration 2026-10-03
// (launch-gate PR-07 / S14 / C7). The purchase has already succeeded, so the
// assignment outcome is unknown. Proven here:
//   - DB confirms the number is NOT assigned → it is released (no orphan rental);
//   - DB shows the number WAS assigned (write committed, error was spurious) → success, NOT released;
//   - DB unreadable → kept (never release a number that may be live), critical alert raised;
//   - a retry after an unknown outcome ADOPTS the tagged number instead of buying another.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ensureTwilioNumberProvisioned } = require('../services/twilioProvisioning.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

function rig({ owned = [] } = {}) {
  const state = { purchased: 0, removed: [], owned: owned.slice() };
  const client = {
    availablePhoneNumbers: () => ({ local: { list: async () => [{ phoneNumber: '+441615550777' }] } }),
    incomingPhoneNumbers: Object.assign(
      (sid) => ({ remove: async () => { state.removed.push(sid); state.owned = state.owned.filter((n) => n.sid !== sid); } }),
      {
        create: async (params) => { state.purchased++; const n = { sid: `PN${state.purchased}`, phoneNumber: params.phoneNumber, friendlyName: params.friendlyName }; state.owned.push(n); return n; },
        list: async ({ friendlyName } = {}) => state.owned.filter((n) => !friendlyName || n.friendlyName === friendlyName),
      },
    ),
  };
  return { state, client };
}
// A minimal guard (the real one is services/abuse/provisioningGuard.js): tags purchases so a retry can adopt.
const guard = {
  singleFlight: async (_id, fn) => fn(),
  admit: async () => ({ allowed: true }),
  friendlyNameFor: (id) => `hcg-hh-${id}`,
  noteSuccessfulPurchase: () => {},
  checkPurchased: () => null,
};
const base = (extra) => ({ recordFailure: async () => {}, appUrl: 'https://example.invalid', isQuarantinedNumber: async () => false, abuseGuard: guard, env: { NODE_ENV: 'test' }, ...extra });
const hh = { id: 'hh-1', twilio_number: null, twilio_provisioning_attempts: 0 };

{
  const { state, client } = rig();
  const alerts = [];
  const r = await ensureTwilioNumberProvisioned(hh, base({ client, assign: async () => { throw new Error('simulated DB error'); }, readHouseholdNumber: async () => null, sendAlert: async (t) => alerts.push(t) }));
  check(state.purchased === 1 && state.removed.includes('PN1') && r.success === false, 'assignment failed and DB confirms no number → the purchased number is released (no orphan rental)');
}
{
  const { state, client } = rig();
  const r = await ensureTwilioNumberProvisioned(hh, base({ client, assign: async () => { throw new Error('timeout after commit'); }, readHouseholdNumber: async () => '+441615550777', sendAlert: async () => {} }));
  check(r.success === true && state.removed.length === 0, 'assignment error but the write committed → success, the live number is NOT released');
}
{
  const { state, client } = rig();
  const alerts = [];
  const r = await ensureTwilioNumberProvisioned(hh, base({ client, assign: async () => { throw new Error('db down'); }, readHouseholdNumber: async () => { throw new Error('db down'); }, sendAlert: async (t) => alerts.push(t) }));
  check(state.removed.length === 0 && r.success === false && alerts.includes('twilio_provisioning_orphan_risk'), 'DB unreadable → number kept (never release a possibly-live number) and a critical orphan-risk alert is raised');
  const retry = await ensureTwilioNumberProvisioned(hh, base({ client, assign: async () => true, readHouseholdNumber: async () => null, sendAlert: async () => {} }));
  check(retry.success && retry.adopted === true && state.purchased === 1, 'the retry ADOPTS the tagged number — never a second purchase');
}

console.log(failures === 0 ? '\nAll provisioning orphan checks passed.' : `\n${failures} provisioning orphan check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
