// Duplicate number purchase under concurrency (soft-launch integration
// 2026-10-04, brief §8). The REAL provisioning path (ensureTwilioNumberProvisioned)
// and the REAL abuse provisioning guard, one guard per simulated server
// instance (so process-local singleFlight cannot help), a shared fake
// provider and a shared claim store modelling migration 066
// claim_number_provisioning. Then the 066 SQL itself on PGlite.
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { applyAll } from './financial-containment-harness.mjs';
const require = createRequire(import.meta.url);
const { ensureTwilioNumberProvisioned } = require('../services/twilioProvisioning.js');
const { createProvisioningGuard } = require('../services/abuse/provisioningGuard.js');
const { createVelocityStore } = require('../services/abuse/velocity.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INSTANCES = 10;

function world() {
  const st = { purchased: 0, removed: [], owned: [], householdNumber: new Map(), claims: new Map() };
  const client = {
    availablePhoneNumbers: () => ({ local: { list: async () => [{ phoneNumber: `+44161555${String(1000 + st.purchased).slice(-4)}` }] } }),
    incomingPhoneNumbers: Object.assign(
      (sid) => ({ remove: async () => { st.removed.push(sid); st.owned = st.owned.filter((n) => n.sid !== sid); } }),
      {
        create: async (p) => { await sleep(5); st.purchased++; const n = { sid: `PN${st.purchased}`, phoneNumber: p.phoneNumber, friendlyName: p.friendlyName }; st.owned.push(n); return n; },
        list: async () => [], // nothing adoptable yet (fresh household)
      },
    ),
  };
  // Atomic "assign if unassigned" (the real RPC is row-locked).
  const assign = async (id, num) => { await sleep(1); if (st.householdNumber.has(id)) return false; st.householdNumber.set(id, num); return true; };
  // 066 semantics: first claim within the TTL wins, the rest get false.
  const claim = async (id, ttlMs) => { const now = Date.now(); const until = st.claims.get(id); if (until && until > now) return false; st.claims.set(id, now + ttlMs); return true; };
  return { st, client, assign, claim };
}
const guardFor = (claimProvisioning) => createProvisioningGuard({
  config: { maxPurchasesGlobalPerHour: 1000, maxPurchasesGlobalPerDay: 1000, incidentAutoTripMs: 60000 },
  incident: { check: async () => ({ allowed: true }), trip: () => {} },
  velocity: createVelocityStore(),
  audit: { record: () => {} },
  accountRisk: { evaluateProvisioning: async () => ({ decision: 'allow', reasons: [], signals: {} }) },
  ...(claimProvisioning ? { claimProvisioning } : {}),
});
const deps = (w, guard, extra = {}) => ({ client: w.client, assign: w.assign, abuseGuard: guard, recordFailure: async () => {}, sendAlert: async () => {}, appUrl: 'https://hcg.test', isQuarantinedNumber: async () => false, readHouseholdNumber: async (id) => w.st.householdNumber.get(id) || null, env: { NODE_ENV: 'test' }, ...extra });
const hh = (id) => ({ id, twilio_number: null, twilio_provisioning_attempts: 0 });

// 1. With the 066 cross-instance claim (wired in server.js 2026-10-04).
{
  const w = world();
  const results = await Promise.all(Array.from({ length: INSTANCES }, () => ensureTwilioNumberProvisioned(hh('hh-A'), deps(w, guardFor(w.claim)))));
  check(w.st.purchased === 1 && w.st.owned.length === 1 && results.filter((r) => r.success).length === 1, `${INSTANCES} instances provision one household at once WITH the 066 claim → exactly 1 purchase, 1 number owned`);
  check(results.filter((r) => !r.success).every((r) => /claimed_elsewhere|held|provisioning_claimed_elsewhere/.test(JSON.stringify(r))), 'the other instances are held (claimed elsewhere), never buying');
}
// 2. Without it (the pre-integration wiring): bounded but wasteful — shows why it was wired.
{
  const w = world();
  await Promise.all(Array.from({ length: INSTANCES }, () => ensureTwilioNumberProvisioned(hh('hh-B'), deps(w, guardFor(null)))));
  check(w.st.owned.length === 1 && w.st.removed.length === w.st.purchased - 1, `WITHOUT the claim: ${w.st.purchased} purchases across instances, every race loser released (${w.st.removed.length}) → 1 number owned (bounded, but avoidable spend)`);
}
// 3. Claim store unavailable → no purchase at all (fail closed).
{
  const w = world();
  const r = await Promise.all(Array.from({ length: 3 }, () => ensureTwilioNumberProvisioned(hh('hh-C'), deps(w, guardFor(async () => { throw new Error('066 not applied'); })))));
  check(w.st.purchased === 0 && r.every((x) => !x.success), 'claim unavailable (066 absent / DB down) → zero purchases (held, never guessed)');
}
// 4. Fortress purchase authorisation: cap honoured under concurrency; throw → none.
{
  const w = world();
  let granted = 0;
  const authorizeNumberPurchase = async () => { await sleep(1); if (granted >= 3) return { allowed: false, reason: 'global_number_purchase_cap' }; granted++; return { allowed: true }; };
  await Promise.all(Array.from({ length: 10 }, (_, i) => ensureTwilioNumberProvisioned(hh(`hh-D${i}`), deps(w, guardFor(w.claim), { authorizeNumberPurchase }))));
  check(w.st.purchased === 3, `10 households at once against a cap of 3 → exactly 3 purchases (got ${w.st.purchased})`);
  const w2 = world();
  await Promise.all(Array.from({ length: 5 }, (_, i) => ensureTwilioNumberProvisioned(hh(`hh-E${i}`), deps(w2, guardFor(w2.claim), { authorizeNumberPurchase: async () => { throw new Error('fortress down'); } }))));
  check(w2.st.purchased === 0, 'Fortress purchase authorisation throws → zero purchases');
}
// 5. The 066 SQL itself.
{
  const db = new PGlite();
  await applyAll(db);
  const id = (await db.query("insert into public.households (auth_user_id, email) values (null, 'claim@test') returning id")).rows[0].id;
  const r = await Promise.all(Array.from({ length: 10 }, () => db.query('select public.claim_number_provisioning($1, 300) as ok', [id]).then((x) => x.rows[0].ok)));
  check(r.filter(Boolean).length === 1, `066 claim_number_provisioning called 10× → exactly one true (${r.filter(Boolean).length})`);
  await db.query("update public.number_provisioning_claims set claimed_until = now() - interval '1 second' where household_id = $1", [id]);
  check((await db.query('select public.claim_number_provisioning($1, 300) as ok', [id])).rows[0].ok === true, 'an expired claim can be taken again (a crashed instance never blocks forever)');
  let bad = false; try { await db.query('select public.claim_number_provisioning($1, 0) as ok', [id]); } catch { bad = true; }
  check(bad, 'invalid TTL is refused');
}
// 6. server.js wires it.
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  check(/claimProvisioning: async \(householdId, ttlMs\) => \{[\s\S]{0,400}rpc\("claim_number_provisioning"/.test(src), 'server.js passes the 066 claim into the abuse layer');
}

console.log(failures === 0 ? '\nNumber purchase races: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
