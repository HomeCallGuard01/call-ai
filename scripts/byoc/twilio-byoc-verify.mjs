#!/usr/bin/env node
// HCG BYOC staging VERIFIER (WS8, 2026-10-11). READ-ONLY: only fetch/list calls.
// Uses SUBACCOUNT credentials TWILIO_BYOC_ACCOUNT_SID / TWILIO_BYOC_AUTH_TOKEN.
//
//   node scripts/byoc/twilio-byoc-verify.mjs --expect-account AC<sub> --production-account AC<parent> \
//        --app-url https://<staging> --fallback-url https://handler.twilio.com/twiml/EH…
//     → numbered PASS/FAIL checklist; exit 1 on any FAIL.
//   … --calls --since 2026-10-12 [--until 2026-10-14]
//     → evidence for the 6-call validation: every Call (parent/child, price,
//       duration; phone numbers masked) and every non-zero usage category.
import { pathToFileURL } from 'node:url';
import { parseArgs, resolveOptions, ACCOUNT_SID_RE } from './lib/byoc-config.mjs';
import { verifyConfig, collectEvidence, realClientFactory } from './lib/byoc-ops.mjs';

export async function main(argv, { env = process.env, log = console.log, err = console.error, clientFactory = realClientFactory } = {}) {
  const args = parseArgs(argv);
  const opts = resolveOptions(args, env);
  const expect = String(args.expectAccount || '');
  const prod = String(args.productionAccount || (env.PRODUCTION_TWILIO_ACCOUNT_SID || env.HCG_PRODUCTION_TWILIO_ACCOUNT_SID) || '');
  if (!ACCOUNT_SID_RE.test(expect)) { err('REFUSED: --expect-account <AC… subaccount> is required'); return 2; }
  if (prod && expect.toLowerCase() === prod.toLowerCase()) { err('REFUSED: --expect-account is the PRODUCTION account'); return 2; }
  if (!env.TWILIO_BYOC_ACCOUNT_SID || !env.TWILIO_BYOC_AUTH_TOKEN) { err('REFUSED: TWILIO_BYOC_ACCOUNT_SID / TWILIO_BYOC_AUTH_TOKEN are required'); return 2; }
  if (env.TWILIO_BYOC_ACCOUNT_SID.toLowerCase() !== expect.toLowerCase()) { err('REFUSED: TWILIO_BYOC_ACCOUNT_SID does not match --expect-account'); return 2; }

  const client = clientFactory(env.TWILIO_BYOC_ACCOUNT_SID, env.TWILIO_BYOC_AUTH_TOKEN);
  if (args.calls) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args.since || ''))) { err('--since YYYY-MM-DD is required with --calls'); return 2; }
    const ev = await collectEvidence(client, { since: args.since, until: args.until });
    log(JSON.stringify(ev, null, 2));
    return 0;
  }
  const account = await client.api.v2010.accounts(expect).fetch();
  const results = await verifyConfig(client, opts, { account, productionSid: prod || null });
  let fails = 0;
  results.forEach((r, i) => { if (!r.ok) fails++; log(`${String(i + 1).padStart(2)}. ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`); });
  log(`\n${results.length - fails}/${results.length} PASS${fails ? ` — ${fails} FAIL` : ''}. Magrathea side (DDI target, channel cap) is not visible to this script.`);
  return fails ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 1; });
}
