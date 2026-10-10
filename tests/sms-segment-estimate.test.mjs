// SMS cost estimate counts billed segments (2026-10-10, duration-evidence
// finding: every warning was authorised as one segment). Pure.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { smsSegments, createSmsBudget } = require('../services/usage/smsBudget.js');
let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
for (const [body, n, label] of [
  ['a'.repeat(160), 1, 'GSM-7 160 chars → 1'], ['a'.repeat(161), 2, 'GSM-7 161 → 2 (153 per part)'], ['a'.repeat(307), 3, 'GSM-7 307 → 3'],
  ['€'.repeat(80), 1, 'extension chars count double (80 × € = 160) → 1'], ['€'.repeat(81), 2, '81 × € → 2'],
  ['“curly quotes” force UCS-2 ' + 'a'.repeat(43), 1, 'UCS-2 70 → 1'], ['“curly quotes” force UCS-2 ' + 'a'.repeat(44), 2, 'UCS-2 71 → 2 (67 per part)'],
  ['😀'.repeat(36), 2, 'astral emoji count as 2 UCS-2 units'], [null, 1, 'null body → 1 (never 0)'],
]) check(smsSegments(body) === n, `${label} (got ${smsSegments(body)})`);

// Both financial layers are charged for the real segment count.
const auths = []; const claims = [];
const budget = createSmsBudget({
  client: { messages: { create: async () => ({ sid: 'SM1' }) } },
  claimSmsSend: async (a) => { claims.push(a); return { allowed: true }; },
  containment: { smsKey: () => 'k', authorizeSpend: async (a) => { auths.push(a); return { allowed: true }; } },
  env: {},
});
await budget.forHousehold('h1', () => ({ periodStart: '2026-10-01', periodEnd: '2026-11-01' })).messages.create({ to: '+447700900123', body: 'x'.repeat(200) });
check(auths[0] && auths[0].units === 2, `Fortress authorised 2 units for a 200-char SMS (got ${auths[0] && auths[0].units})`);
await budget.forHousehold('h1', () => ({ periodStart: '2026-10-01', periodEnd: '2026-11-01' })).messages.create({ to: '+447700900123', body: 'short warning' });
check(claims.length === 2 && claims[1].costGbp > 0 && Math.abs(claims[0].costGbp - 2 * claims[1].costGbp) < 1e-9,
  `Layer B claim for the 2-segment SMS is exactly twice the 1-segment claim (${claims[0] && claims[0].costGbp} vs ${claims[1] && claims[1].costGbp})`);
console.log(failures === 0 ? '\nSMS segment estimate: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
