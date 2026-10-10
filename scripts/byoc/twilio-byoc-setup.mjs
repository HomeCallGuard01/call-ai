#!/usr/bin/env node
// HCG Magrathea → Twilio BYOC STAGING setup (WS8, 2026-10-11). PREPARED, NOT RUN.
//
// DRY RUN BY DEFAULT: prints the exact Twilio API calls, touches nothing, needs
// no credentials.
//
//   node scripts/byoc/twilio-byoc-setup.mjs                         # plan only
//   node scripts/byoc/twilio-byoc-setup.mjs --app-url https://<staging> --fallback-url https://handler.twilio.com/twiml/EH…
//
// Step "configure" (default; SUBACCOUNT credentials TWILIO_BYOC_ACCOUNT_SID /
// TWILIO_BYOC_AUTH_TOKEN — the env names WS6 introduces):
//   … --apply --expect-account AC<sub> --production-account AC<parent> --confirm APPLY-BYOC-<last6 of sub>
//   Refuses unless: the SID is not production/parent; Twilio itself reports the
//   account as a SUBACCOUNT named hcg-byoc-staging, active, with no hosted
//   numbers; URLs are https and not production; fallback is a TwiML Bin.
//   Idempotent: finds every resource by name and creates/updates only drift.
//
// Step "subaccount" (PARENT credentials BYOC_PARENT_ACCOUNT_SID /
// BYOC_PARENT_AUTH_TOKEN; the Console is preferred — see the prep doc §b):
//   … --step subaccount --apply --expect-parent AC<parent> --confirm CREATE-SUBACCOUNT-<last6 of parent>
//   Only ever creates ONE subaccount named hcg-byoc-staging (reuses it if it
//   exists) and prints its SID — never its auth token.
import { pathToFileURL } from 'node:url';
import {
  NAMES, parseArgs, resolveOptions, buildSetupPlan, formatPlan, confirmationToken,
  checkSubaccountApply, checkAccountIdentity, checkParentStep,
} from './lib/byoc-config.mjs';
import { applySetup, realClientFactory, AbortError } from './lib/byoc-ops.mjs';

export async function main(argv, { env = process.env, log = console.log, err = console.error, clientFactory = realClientFactory } = {}) {
  const args = parseArgs(argv);
  const step = args.step || 'configure';
  const opts = resolveOptions(args, env);

  if (step === 'subaccount') {
    log(`[SUB] ${args.apply ? 'APPLY' : 'DRY RUN'}: ensure ONE subaccount "${NAMES.subaccount}" under the parent`);
    log('    GET  https://api.twilio.com/2010-04-01/Accounts.json?FriendlyName=hcg-byoc-staging   sdk: client.api.v2010.accounts.list({ friendlyName })');
    log('    POST https://api.twilio.com/2010-04-01/Accounts.json FriendlyName=hcg-byoc-staging   sdk: client.api.v2010.accounts.create({ friendlyName })  (only if none)');
    if (!args.apply) { log(`\nDRY RUN — nothing created. To apply: --apply --expect-parent AC… --confirm ${confirmationToken('CREATE-SUBACCOUNT', args.expectParent || 'AC…')}`); return 0; }
    const errors = checkParentStep({ args, env, kind: 'CREATE-SUBACCOUNT' });
    if (errors.length) { errors.forEach((e) => err(`REFUSED: ${e}`)); return 2; }
    const client = clientFactory(env.BYOC_PARENT_ACCOUNT_SID, env.BYOC_PARENT_AUTH_TOKEN);
    const parent = await client.api.v2010.accounts(args.expectParent).fetch();
    if (!parent || parent.sid !== args.expectParent || (parent.ownerAccountSid && parent.ownerAccountSid !== parent.sid)) {
      err('REFUSED: --expect-parent is not a main account reachable with these credentials'); return 2;
    }
    const existing = (await client.api.v2010.accounts.list({ friendlyName: NAMES.subaccount, limit: 20 })).filter((a) => a.status !== 'closed');
    if (existing.length > 1) { err(`REFUSED: ${existing.length} open subaccounts named ${NAMES.subaccount}; resolve in the Console`); return 2; }
    if (existing.length === 1) { log(`exists  subaccount ${existing[0].sid} (status ${existing[0].status})`); return 0; }
    const sub = await client.api.v2010.accounts.create({ friendlyName: NAMES.subaccount });
    log(`created subaccount ${sub.sid}. Read its auth token in the Console (never printed here) and set TWILIO_BYOC_ACCOUNT_SID/TWILIO_BYOC_AUTH_TOKEN.`);
    return 0;
  }

  if (step !== 'configure') { err(`unknown --step ${step}`); return 2; }
  const sub = args.expectAccount || env.TWILIO_BYOC_ACCOUNT_SID || '<BYOC_SUBACCOUNT_SID>';
  log(`HCG BYOC staging setup — ${args.apply ? 'APPLY' : 'DRY RUN'} — target subaccount ${sub}`);
  log(`Carrier target for Magrathea: S:${opts.ddi}@${opts.terminationUri}\n`);
  log(formatPlan(buildSetupPlan(opts, sub)));
  if (!args.apply) {
    log(`\nDRY RUN — no Twilio call was made. To apply (after Andrew's GO): --apply --expect-account <AC sub> --production-account <AC parent> --confirm ${confirmationToken('APPLY-BYOC', args.expectAccount || 'AC…')}`);
    return 0;
  }
  const errors = checkSubaccountApply({ args, env, opts, kind: 'APPLY-BYOC' });
  if (errors.length) { errors.forEach((e) => err(`REFUSED: ${e}`)); return 2; }
  const productionSid = args.productionAccount || (env.PRODUCTION_TWILIO_ACCOUNT_SID || env.HCG_PRODUCTION_TWILIO_ACCOUNT_SID);
  const client = clientFactory(env.TWILIO_BYOC_ACCOUNT_SID, env.TWILIO_BYOC_AUTH_TOKEN);
  const account = await client.api.v2010.accounts(args.expectAccount).fetch();
  const idErrors = checkAccountIdentity(account, { expectAccount: args.expectAccount, productionSid });
  if (idErrors.length) { idErrors.forEach((e) => err(`REFUSED: ${e}`)); return 2; }
  try {
    const out = await applySetup(client, opts, log);
    log(`\nDONE. Next: node scripts/byoc/twilio-byoc-verify.mjs --expect-account ${args.expectAccount} … (read-only). Created/kept: ${JSON.stringify(out)}`);
    return 0;
  } catch (e) {
    if (e instanceof AbortError) { err(e.message); return 3; }
    err(`FAILED: ${e.message}`); return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 1; });
}
