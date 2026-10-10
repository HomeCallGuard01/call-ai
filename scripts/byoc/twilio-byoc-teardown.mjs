#!/usr/bin/env node
// HCG BYOC staging TEARDOWN (WS8, 2026-10-11). PREPARED, NOT RUN. DRY RUN BY DEFAULT.
//
// Step "configure" (default; SUBACCOUNT credentials): deletes ONLY the resources
// setup created, found by their exact names (triggers prefixed hcg-byoc-staging,
// the domain hcg-byoc-staging.sip.twilio.com, trunk, ACL, TwiML App).
//   … --apply --expect-account AC<sub> --production-account AC<parent>
//         --magrathea-repointed "<date + ticket ref>" --confirm TEARDOWN-BYOC-<last6 of sub>
//
// Step "suspend" (PARENT credentials BYOC_PARENT_ACCOUNT_SID/TOKEN; Console preferred):
//   … --step suspend --apply --expect-parent AC<parent> --expect-account AC<sub> --confirm SUSPEND-BYOC-<last6 of sub>
//   In-progress calls do NOT end on suspension (Twilio subaccounts doc).
//   Closing is NOT offered: irreversible; do it in the Console after evidence export.
import { pathToFileURL } from 'node:url';
import {
  NAMES, parseArgs, resolveOptions, buildTeardownPlan, formatPlan, confirmationToken,
  checkSubaccountApply, checkAccountIdentity, checkParentStep,
} from './lib/byoc-config.mjs';
import { applyTeardown, realClientFactory } from './lib/byoc-ops.mjs';

export async function main(argv, { env = process.env, log = console.log, err = console.error, clientFactory = realClientFactory } = {}) {
  const args = parseArgs(argv);
  const step = args.step || 'configure';
  const opts = resolveOptions(args, env);
  const sub = args.expectAccount || env.TWILIO_BYOC_ACCOUNT_SID || '<BYOC_SUBACCOUNT_SID>';

  if (step === 'suspend') {
    log(`[T6] ${args.apply ? 'APPLY' : 'DRY RUN'}: POST https://api.twilio.com/2010-04-01/Accounts/${sub}.json Status=suspended`);
    if (!args.apply) { log(`\nDRY RUN — nothing changed. To apply: --apply --expect-parent AC… --expect-account ${sub} --confirm ${confirmationToken('SUSPEND-BYOC', sub)}`); return 0; }
    const errors = checkParentStep({ args, env, kind: 'SUSPEND-BYOC' });
    if (errors.length) { errors.forEach((e) => err(`REFUSED: ${e}`)); return 2; }
    const client = clientFactory(env.BYOC_PARENT_ACCOUNT_SID, env.BYOC_PARENT_AUTH_TOKEN);
    const acct = await client.api.v2010.accounts(args.expectAccount).fetch();
    if (!acct || acct.ownerAccountSid !== args.expectParent || acct.friendlyName !== NAMES.subaccount) {
      err(`REFUSED: ${args.expectAccount} is not the ${NAMES.subaccount} subaccount of ${args.expectParent}`); return 2;
    }
    if (acct.status === 'suspended') { log('already suspended'); return 0; }
    await client.api.v2010.accounts(args.expectAccount).update({ status: 'suspended' });
    log(`suspended ${args.expectAccount}. Live calls (if any) continue until they end: check the Calls log.`);
    return 0;
  }

  if (step !== 'configure') { err(`unknown --step ${step}`); return 2; }
  log(`HCG BYOC staging teardown — ${args.apply ? 'APPLY' : 'DRY RUN'} — subaccount ${sub}\n`);
  log(formatPlan(buildTeardownPlan(opts, sub)));
  if (!args.apply) {
    log(`\nDRY RUN — no Twilio call was made. To apply: --apply --expect-account <AC sub> --production-account <AC parent> --magrathea-repointed "<ref>" --confirm ${confirmationToken('TEARDOWN-BYOC', args.expectAccount || 'AC…')}`);
    return 0;
  }
  const errors = checkSubaccountApply({ args, env, opts, kind: 'TEARDOWN-BYOC' });
  if (errors.length) { errors.forEach((e) => err(`REFUSED: ${e}`)); return 2; }
  const productionSid = args.productionAccount || (env.PRODUCTION_TWILIO_ACCOUNT_SID || env.HCG_PRODUCTION_TWILIO_ACCOUNT_SID);
  const client = clientFactory(env.TWILIO_BYOC_ACCOUNT_SID, env.TWILIO_BYOC_AUTH_TOKEN);
  const account = await client.api.v2010.accounts(args.expectAccount).fetch();
  // A suspended subaccount cannot be torn down via its own credentials; status may be active only.
  const idErrors = checkAccountIdentity(account, { expectAccount: args.expectAccount, productionSid });
  if (idErrors.length) { idErrors.forEach((e) => err(`REFUSED: ${e}`)); return 2; }
  log(`Magrathea re-point confirmation: ${args.magratheaRepointed}`);
  try { await applyTeardown(client, opts, log); } catch (e) { err(`FAILED: ${e.message}`); return 1; }
  log('\nDONE. Next (optional): --step suspend with parent credentials, or suspend in the Console.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 1; });
}
