// pgliteRestBridge.mjs — integration 2026-10-03 (Launch Fortress).
//
// The black-box harnesses (tests/telephony-abuse-attacks.test.mjs,
// tests/voice-surface-security.test.mjs) boot the REAL server.js against a
// local fake Supabase. Before integration that fake answered every RPC with
// `[]`. Once the Financial Fortress is in server.js, an `[]` from
// fc_authorize_call is (correctly) a malformed authority response, so the
// server falls back to its degraded envelope (unmonitored, 2 concurrent,
// 20/hour) — the harness would then be testing the outage path, not fraud.
//
// This bridge makes the fake's `POST /rest/v1/rpc/<fn>` run the REAL SQL:
// every migration in supabase/migrations/ (056 admission, the Fortress
// ledger, …) applied to an in-process PGlite, with the harness's households
// and entitlements seeded under the same ids. Table GETs stay with each
// harness's fixtures. Nothing here talks to a network service.
//
// PGlite is ONE connection: this proves wiring and SQL semantics through the
// real server, NOT multi-instance races (tests/financial-containment-realpg.test.mjs).
import { PGlite } from '@electric-sql/pglite';
import { applyAll } from '../financial-containment-harness.mjs';

export async function createFortressBridge({ households = [], entitlements = [], profile = null } = {}) {
  const db = new PGlite();
  await applyAll(db);
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;

  for (const h of households) {
    await q('insert into public.households (id, auth_user_id, email, twilio_number, phone_number) values ($1, null, $2, $3, $4)',
      [h.id, h.email || `${h.id}@example.invalid`, h.twilio_number || null, h.phone_number || null]);
  }
  for (const e of entitlements) {
    await q(`insert into public.entitlements (household_id, entitlement_type, status, source, starts_at, ends_at)
             values ($1, $2, $3, $4, $5, $6)`,
    [e.household_id, e.entitlement_type || 'paid_subscription', e.status || 'active', e.source || 'test', e.starts_at || '2026-09-01T00:00:00Z', e.ends_at || null]);
  }
  // Pin a test budget profile so fraud tests are not testing the (undecided,
  // D1) commercial seed figures. A scenario that wants exhaustion sets its own.
  if (profile) {
    for (const name of ['standard', 'complimentary', 'internal_test']) {
      await q('select public.fc_set_budget_profile($1,$2,$3,$4,$5,$6,$7,$8)',
        [name, profile.budget, profile.reserve, profile.scope || 'trusted_only', profile.essential ?? 0.1, profile.monitoring !== false, 'pin harness profile', 'harness']);
    }
  }

  const retset = new Map();
  async function isSetReturning(name) {
    if (!retset.has(name)) {
      const rows = await q("select bool_or(p.proretset) as r from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1", [name]);
      retset.set(name, rows.length ? rows[0].r : null);
    }
    return retset.get(name);
  }

  const calls = [];
  /** Handle one PostgREST RPC: returns { status, body } (body is JSON text). */
  async function rpc(name, rawBody) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) return { status: 404, body: JSON.stringify({ message: 'bad function name' }) };
    let params = {};
    try { params = rawBody ? JSON.parse(rawBody) : {}; } catch { return { status: 400, body: JSON.stringify({ message: 'bad json' }) }; }
    calls.push(name);
    const sr = await isSetReturning(name);
    if (sr === null) return { status: 404, body: JSON.stringify({ code: 'PGRST202', message: `function ${name} not found` }) };
    const keys = Object.keys(params);
    const args = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
    const values = keys.map((k) => {
      const v = params[k];
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    });
    try {
      if (sr) {
        const rows = await q(`select * from public.${name}(${args})`, values);
        return { status: 200, body: JSON.stringify(rows) };
      }
      const rows = await q(`select public.${name}(${args}) as r`, values);
      return { status: 200, body: JSON.stringify(rows.length ? rows[0].r : null) };
    } catch (err) {
      return { status: 400, body: JSON.stringify({ code: 'P0001', message: err.message }) };
    }
  }

  return { db, q, rpc, calls, close: () => db.close() };
}
