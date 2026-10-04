// Accounting is NEVER an entitlement authority and can never block, delay or
// change entitlement handling (soft-launch integration 2026-10-04, brief §6
// C11/C12). Capture is OFF by default, bounded by a timeout, and its result is
// ignored by both webhook routes; no accounting code or SQL writes
// entitlement, household or subscription state.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createAccountingCapture } = require('../services/accounting/capture');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

// ── Default OFF; nothing loads while off ─────────────────────────────────
{
  let built = false;
  const off = createAccountingCapture({ env: {}, deps: { get store() { built = true; return {}; } } });
  const r = await off.captureStripeEvent({ id: 'evt_1', type: 'invoice.paid' });
  check(r.captured === false && r.reason === 'disabled' && !built, 'ACCOUNTING_CAPTURE_ENABLED unset → capture disabled, engine never constructed');
  check((await createAccountingCapture({ env: { ACCOUNTING_CAPTURE_ENABLED: 'TRUE' } }).captureStripeEvent({})).reason === 'disabled', "only the exact string 'true' enables it");
}

// ── Bounded: a hanging accounting store cannot hold the webhook ──────────
{
  const alerts = [];
  const hanging = createAccountingCapture({
    env: { ACCOUNTING_CAPTURE_ENABLED: 'true', ACCOUNTING_CAPTURE_TIMEOUT_MS: '150' },
    deps: { supabase: {}, store: {}, resolver: {}, sendCriticalAlert: () => new Promise(() => { alerts.push('x'); }) },
  });
  // Replace the engine with one whose ingest never resolves.
  const engineModule = require('../services/accounting/engine');
  const orig = engineModule.createAccountingEngine;
  engineModule.createAccountingEngine = () => ({ ingestStripeEvent: () => new Promise(() => {}), ingestRevenueCatEvent: () => new Promise(() => {}) });
  const t0 = Date.now();
  const r = await hanging.captureStripeEvent({ id: 'evt_hang' });
  const ms = Date.now() - t0;
  engineModule.createAccountingEngine = orig;
  check(r.captured === false && r.reason === 'timeout' && ms < 1000, `hung accounting store → capture gives up in ${ms} ms (timeout), never blocks`);
  check(alerts.length === 1, 'a never-resolving alert channel does not block either (fire-and-forget)');
  const throwing = createAccountingCapture({ env: { ACCOUNTING_CAPTURE_ENABLED: 'true' }, deps: { supabase: null, sendCriticalAlert: () => { throw new Error('alerting down'); } } });
  const t = await throwing.captureRevenueCatEvent({});
  check(t.captured === false && t.reason === 'error', 'capture never throws, even when both the store and alerting fail');
}

// ── Routes ignore the capture result ─────────────────────────────────────
for (const [file, call] of [['routes/billing.js', 'captureStripeEvent(event)'], ['routes/mobileApi.js', 'captureRevenueCatEvent(req.body)']]) {
  const src = readFileSync(path.join(ROOT, file), 'utf8');
  const line = src.split('\n').find((l) => l.includes(call));
  check(line && /^\s*await accountingCapture\.\w+\([^)]*\);\s*$/.test(line), `${file}: capture result is discarded (statement only, never branches entitlement handling)`);
}

// ── No accounting code or SQL writes entitlement/household/subscription state ─
{
  const dir = path.join(ROOT, 'services/accounting');
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(dir);
  const offenders = files.filter((f) => /from\(['"](entitlements|households|subscriptions|stripe_webhook_events|fc_[a-z_]+)['"]\)\s*\.(insert|update|upsert|delete)/.test(readFileSync(f, 'utf8')) || /rpc\(['"](process_stripe_webhook_event|fc_|grant_|revoke_|anonymize)/.test(readFileSync(f, 'utf8')));
  check(files.length > 10 && offenders.length === 0, `services/accounting/** (${files.length} files) never writes entitlements/households/subscriptions/webhook/Fortress state (offenders: ${offenders.map((f) => path.relative(ROOT, f)).join(',') || 'none'})`);
  const sql = readFileSync(path.join(ROOT, 'supabase/migrations/071_accounting_transactions.sql'), 'utf8').replace(/--.*$/gm, '');
  check(!/(insert\s+into|update|delete\s+from)\s+public\.(entitlements|households|subscriptions|stripe_webhook_events|fc_)/i.test(sql), 'migration 071 never modifies entitlements/households/subscriptions/webhook/Fortress tables');
}

// ── Posting stays OFF without accountant decisions (config) ──────────────
{
  const { evaluateLaunchConfig } = require('../services/config/launchConfig');
  const r = evaluateLaunchConfig({ HCG_DEPLOYMENT: 'production', ACCOUNTING_XERO_POSTING_ENABLED: 'true' });
  check(r.fatal.some((f) => f.id === 'xero_posting_decisions'), 'production refuses to start with Xero posting on before AD-1..AD-11 are confirmed');
}

console.log(failures === 0 ? '\nAccounting integration safety: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
