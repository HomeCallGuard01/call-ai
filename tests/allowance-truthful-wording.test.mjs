// DT-2 truthful allowance wording (real-device finding 2026-10-05).
// On the Fortress £ basis the meter is the household's monthly protection
// spend: every handled call uses it (two ~45 s TRUSTED calls took 12% of the
// £0.20 staging budget). Customer copy on that basis must therefore never say
// "call checking", never promise minutes, and never say trusted calls don't
// use it — while the 056 minutes basis keeps its (true) original wording.
//
// Run with: node tests/allowance-truthful-wording.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = path.join(__dirname, '..');
const notices = require('../services/allowance/allowanceNotices.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const FALSE_ON_SPEND = [/don't use it/i, /trusted contacts (are )?not affected/i, /\bminutes?\b/i, /call checking/i];

// ── 1. Emails ───────────────────────────────────────────────────────────
{
  const al = { resetsAt: '2026-11-01T00:00:00Z', remainingPercent: 25 };
  const spend = { basis: 'protection_spend', trustedCallsUseAllowance: true };
  const emails = [
    notices.noticeEmail('warn_75', al, spend),
    notices.noticeEmail('warn_90', { ...al, remainingPercent: 8 }, spend),
    notices.noticeEmail('exhausted_100', al, { ...spend, callsContinue: true }),
    notices.noticeEmail('exhausted_100', al, { ...spend, callsContinue: false, trustedCallersContinue: true }),
    notices.noticeEmail('exhausted_100', al, { ...spend, callsContinue: false, trustedCallersContinue: false }),
  ];
  check(emails.every((e) => FALSE_ON_SPEND.every((re) => !re.test(e.subject + ' ' + e.text))), 'spend-basis emails: no "call checking", no minutes, no "trusted not affected/don\'t use it"');
  check(/protection allowance/.test(emails[0].subject) && /Every call Home Call Guard handles uses a little of it/.test(emails[0].text), 'warning email explains plainly that every handled call uses it');
  check(/may not get through/.test(emails[3].text) && /turn off call forwarding/.test(emails[3].text) && !/Calls still reach you/.test(emails[3].text), 'used up with trusted-only reserve: says other calls may not get through (never "calls still reach you"), and how to get calls back');
  check(/Calls still reach you/.test(emails[2].text), 'used up while calls continue: says calls still reach you (true in that state)');
  const legacy = notices.noticeEmail('warn_75', al);
  check(/call checking/.test(legacy.subject) && /trusted contacts are not affected/.test(legacy.text), 'minutes basis (no read model / 056): original wording unchanged');
}

// ── 2. App and web copy (source) ────────────────────────────────────────
{
  const meter = readFileSync(path.join(root, 'mobile', 'components', 'AllowanceMeter.tsx'), 'utf8');
  check(/a\.basis === "protection_spend" \|\| a\.trustedCallsUseAllowance === true/.test(meter), 'app: spend basis detected from the server payload');
  check(/"PROTECTION ALLOWANCE THIS MONTH" : "CALL CHECKING THIS MONTH"/.test(meter) && /\{allowanceTitle\(allowance\)\}/.test(meter), 'app: title follows the basis');
  const spendBranches = [...meter.matchAll(/spend\s*\?\s*("[^"]*"|`[^`]*`)/g)].map((m) => m[1]);
  const usedUpSpend = meter.slice(meter.indexOf('if (spend) {'), meter.indexOf('\n      }\n', meter.indexOf('if (spend) {')));
  const usedUpStrings = [...usedUpSpend.matchAll(/("[^"]*"|`[^`]*`)/g)].map((m) => m[1]);
  const all = [...spendBranches, ...usedUpStrings];
  check(spendBranches.length >= 3 && usedUpStrings.length === 2 && all.every((t) => FALSE_ON_SPEND.every((re) => !re.test(t))), `app: every spend-basis message (incl. both "used up" variants) avoids minutes/"call checking"/trusted-exempt claims (${all.length} checked)`);
  const web = readFileSync(path.join(root, 'upload.html'), 'utf8');
  check(/function isSpendBasis\(a\)/.test(web) && /"Protection allowance this month" : "Call checking this month"/.test(web), 'web: title follows the basis');
  const webSpend = [...web.matchAll(/spend\s*\?\s*("[^"]*")/g)].map((m) => m[1]);
  check(webSpend.length >= 3 && webSpend.every((t) => FALSE_ON_SPEND.every((re) => !re.test(t))), `web: spend-basis messages avoid the false claims (${webSpend.length} checked)`);
  check(/spendBasis\s*\?\s*"Add more protection allowance/.test(web), 'web: a top-up on the spend basis never offers "minutes"');
  const hint = web.match(/const SPEND_BASIS_HINT = "([^"]+)"/);
  check(hint && FALSE_ON_SPEND.every((re) => !re.test(hint[1])), 'web: spend-basis help text has no false claims');
}

// ── 3. Containment untouched ────────────────────────────────────────────
{
  const adapter = readFileSync(path.join(root, 'services', 'allowance', 'fortressAdapter.js'), 'utf8');
  check(/const fraction = total > 0 \? \(consumed \+ reserved\) \/ total : 1;/.test(adapter), 'the percentage calculation itself is unchanged (consumed + reserved over budget)');
}

console.log(failures === 0 ? '\nTruthful allowance wording: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
