// Expensive-destination policy (integration 2026-10-04, decisions 3–5).
// Trusted status never overrides destination policy; unknown callers get the
// same restrictions; contact creation is validated server-side; and a fail-safe
// COST CEILING refuses any class with no known rate — so an expensive range is
// not permitted merely because a static blocklist (client or server) omitted it.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const np = require('../services/abuse/numberPolicy.js');
const { isValidContactNumber, findProhibitedContacts, normaliseUkPhoneToE164 } = require('../services/phone.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const { PURPOSES, CLASSES, evaluateNumberForPurpose } = np;

const EXPENSIVE = {
  '09 premium-rate': '+449098790123',
  '087 revenue-share': '+448712345678',
  '084 revenue-share': '+448451234567',
  '070 personal numbering': '+447012345678',
  '076 paging': '+447612345678',
  'other special (081–089)': '+448181234567',
  'freephone (no HCG reason to dial)': '+448001234567',
  'satellite / global service +881': '+8816123456789',
  'international premium-style +882': '+88234567890',
  'UK unallocated (04/06)': '+446123456789',
};
const UK_LOOKING_ELSEWHERE = { 'Isle of Man mobile 07624': '+447624123456', 'Jersey 01534': '+441534123456', 'Guernsey 01481': '+441481123456' };

// Every HCG-paid purpose refuses every expensive / non-standard class.
for (const [purpose, label] of [[PURPOSES.SMS_WARNING, 'warning SMS'], [PURPOSES.HOUSEHOLD_PHONE, 'customer/account number'], [PURPOSES.PSTN_DIAL, 'HCG-originated call (forwarding/routing)'], [PURPOSES.PROVISIONED_NUMBER, 'number purchase']]) {
  const allowedBad = Object.entries({ ...EXPENSIVE, ...UK_LOOKING_ELSEWHERE }).filter(([, n]) => evaluateNumberForPurpose(purpose, n).allowed).map(([k]) => k);
  check(allowedBad.length === 0, `${label}: every premium / revenue-share / 070 / 076 / satellite / international / Crown Dependency number refused (${allowedBad.join(', ') || 'none allowed'})`);
}
check(evaluateNumberForPurpose(PURPOSES.PSTN_DIAL, '+447700900123').allowed === false, 'HCG-originated PSTN: even an ordinary UK mobile is refused (no product path; no voice rate ⇒ cost ceiling refuses)');

// Fail-safe ceiling: a class added to an allowlist without a known rate is still refused.
const careless = { name: 'careless', allow: [CLASSES.UK_MOBILE, CLASSES.UK_PREMIUM_RATE, CLASSES.INTERNATIONAL], costKind: 'sms', maxUnitCostGbp: 0.05 };
const r1 = evaluateNumberForPurpose(careless, '+449098790123');
const r2 = evaluateNumberForPurpose(careless, '+33612345678');
check(!r1.allowed && r1.reason === 'cost_unknown:uk_premium_rate' && !r2.allowed && r2.reason === 'cost_unknown:international',
  'FAIL-SAFE: a premium/international class mistakenly ALLOWLISTED is still refused — no known rate ⇒ cost_unknown');
const tightCeiling = { ...PURPOSES.SMS_WARNING, maxUnitCostGbp: 0.01 };
check(evaluateNumberForPurpose(tightCeiling, '+447700900123').reason === 'cost_above_ceiling:uk_mobile', 'a destination whose known rate exceeds the ceiling is refused (cost_above_ceiling)');
check(Object.values(PURPOSES).every((p) => p.costKind === null || (typeof p.maxUnitCostGbp === 'number' && np.DESTINATION_UNIT_COST_GBP[p.costKind])), 'every HCG-paid purpose declares a cost kind and a maximum unit cost');
// Provider metadata is stronger than prefixes (port; not wired in production).
check(evaluateNumberForPurpose(PURPOSES.SMS_WARNING, '+447700900123', { providerClassification: { country: 'GG', lineType: 'mobile' } }).reason === 'provider_country_not_gb'
  && evaluateNumberForPurpose(PURPOSES.SMS_WARNING, '+447700900123', { providerClassification: { country: 'GB', lineType: 'premium' } }).reason === 'provider_line_type:premium',
  'provider metadata overrides a "UK mobile-looking" prefix (e.g. a Guernsey mobile inside 077–079, or a premium line type)');

// Trusted contacts: refused at creation server-side (every write path), and
// never trusted at call time even if inserted directly into the database.
const bad = Object.entries(EXPENSIVE).filter(([k]) => !/international premium-style/.test(k));
check(bad.every(([, n]) => !isValidContactNumber(n.startsWith('+44') ? n.slice(3) : n)), 'trusted-contact CREATION refuses every expensive class server-side (client-side validation is not relied on)');
check(isValidContactNumber('7700900123') && isValidContactNumber('+33612345678'), 'ordinary UK and genuine international family numbers can still be trusted contacts (caller-ID matchers only: never dialled or messaged)');
const found = findProhibitedContacts([{ id: 'a', household_id: 'h', number: '9098790123' }, { id: 'b', household_id: 'h', number: '7700900123' }, { id: 'c', household_id: 'h', number: '7012345678' }]);
check(found.length === 2 && found.every((f) => /…/.test(f.numberMasked)), 'existing prohibited contacts (e.g. inserted directly in the DB) are DETECTED, masked, for support');
const guard = readFileSync(path.join(ROOT, 'services', 'abuse', 'inboundCallGuard.js'), 'utf8');
check(guard.indexOf('// 10. trusted-contact bypass') > guard.indexOf('// 8. concurrency') && /PURPOSES\.TRUSTED_CONTACT\.allow\.includes\(from\.class\)/.test(guard),
  'call time: the trusted decision is LAST and re-checks the caller class, so a premium number stored as a contact (or changed after validation) never gets trust');
for (const f of ['server.js', 'routes/mobileApi.js', 'services/contactsSync.js']) {
  const src = readFileSync(path.join(ROOT, f), 'utf8');
  check(/isValidContactNumber\(/.test(src), `${f}: contact writes go through isValidContactNumber (the destination policy)`);
}
check(normaliseUkPhoneToE164('09098790123') === null && normaliseUkPhoneToE164('07624123456') === null, 'customer/account number: premium and Isle of Man refused at normalisation (plus the write-path policy)');

console.log(failures === 0 ? '\nAll destination cost-policy checks passed.' : `\n${failures} destination check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
