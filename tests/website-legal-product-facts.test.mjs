// Public website — legal/product-fact consistency (2026-09-29).
//
// Pins customer-facing statements to what the code actually does, so the
// Terms and site copy can't silently drift back to the landline/web-dashboard
// era or claim things the page can't verify:
//   1. Terms describe the current product: UK mobile numbers, one mobile phone
//      number per subscription, managed in the app — no "home telephone line".
//   2. The Terms "Last updated" date matches services/legalVersions.js's
//      TERMS_VERSION (recorded against every acceptance, migration 039).
//   3. The homepage's description of an unknown call matches server.js /voice:
//      the caller hears the protection announcement before the phone rings.
//   4. No page claims an App Review status it can't verify.
//
// Run with: node tests/website-legal-product-facts.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(path.join(root, ...p), 'utf8');
const require = createRequire(import.meta.url);

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}
const visible = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// ---------- 1. Terms describe the mobile product ----------
const terms = read('public', 'terms.html');
const termsText = visible(terms);
check(!/home telephone|telephone line per subscription|home phone/i.test(termsText), 'Terms: no "home telephone (line/number)" or "home phone" product wording');
check(/call-screening service for UK mobile phone numbers/.test(termsText), 'Terms §2: the Service is described as covering UK mobile phone numbers');
check(/protecting one mobile phone number per subscription/.test(termsText), 'Terms §9: one mobile phone number per subscription');
check(!/online dashboard/i.test(termsText) && !/Where a Home Call Guard mobile app is made available/.test(termsText), 'Terms §2: account managed in the app (no "online dashboard" / "where a mobile app is made available" wording)');
check(/"Manage membership" option in the Home Call Guard app/.test(termsText) && !/in your dashboard/i.test(termsText), 'Terms §5/§6: cancellation and activity point to the app, not "your dashboard"');
check(/£4\.99 per month/.test(termsText) && /inclusive of any VAT/.test(termsText), 'Terms §3: £4.99 per month, VAT inclusive (unchanged)');

// ---------- 2. Terms date == recorded TERMS_VERSION ----------
const { TERMS_VERSION } = require(path.join(root, 'services', 'legalVersions.js'));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const m = terms.match(/Last updated: (\d{1,2}) ([A-Z][a-z]+) (\d{4})/);
const termsIso = m ? `${m[3]}-${String(MONTHS.indexOf(m[2]) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
check(termsIso === TERMS_VERSION, `Terms "Last updated" (${termsIso}) matches services/legalVersions.js TERMS_VERSION (${TERMS_VERSION}) — the version recorded against each acceptance`);

// ---------- 3. homepage unknown-call description matches /voice ----------
const server = read('server.js');
const ANNOUNCEMENT = 'This number is monitored and protected by Home Call Guard.';
const home = read('public', 'index.html');
const howItWorks = home.slice(home.indexOf('<section id="how-it-works">'), home.indexOf('</section>', home.indexOf('<section id="how-it-works">')));
check(server.includes(ANNOUNCEMENT), '/voice still plays the protection announcement to monitored callers (if this fails, update the homepage too)');
check(/caller first hears a short message that your number is protected by Home Call Guard/.test(visible(howItWorks)), 'homepage How it works: says the caller first hears a short protection message (matches /voice)');

// ---------- 4. no unverifiable App Review status ----------
const APPROVAL = /App Store approval|final approval|awaiting approval|waiting for (final )?(Apple|App Store|approval)/i;
for (const f of [['public', 'index.html'], ['public', 'go.html'], ['upload.html'], ['public', 'support.html']]) {
  check(!APPROVAL.test(visible(read(...f))), `${f.join('/')}: no App Review status claimed`);
}
check(!/Is my home phone number changing/.test(read('upload.html')), 'upload.html dashboard FAQ: no "home phone number" (mobile product)');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
