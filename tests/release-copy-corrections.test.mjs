// Copy-only regression guard for the v10 release corrections (2026-09-21):
//   1. customer-facing mobile wording "AI-powered call protection" -> "Scam call protection"
//   2. the £4.99 price states "including VAT" where it is presented without it
//      (mobile welcome/complete, and the Membership priceLabel the server sends
//      to both the app and the website) — the price itself is unchanged
//   3. the 30-day money-back guarantee wording is gone from the mobile
//      welcome and complete screens, and is NOT replaced by another guarantee
//   4. the repo's Google Play listing draft no longer claims landline
//      protection or calls stopped "before they reach you", and reflects the
//      current availability (Android now; iPhone + Landline Coming Soon)
//
// Deliberately NOT asserted here (outside this correction's scope, flagged for a
// separate decision): the guarantee box / consent text on the Subscribe screen,
// the guarantee sentence on the post-payment confirmation screen, the web
// consent line, the Stripe Checkout page text, and the Terms.
//
// Run with: node tests/release-copy-corrections.test.mjs
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(path.join(root, ...p), 'utf8');
let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}
// Code lines only: drop // and /* */ comments so explanations of history don't trip the guards.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---- 1. AI-powered ----
const subscribe = read('mobile', 'app', '(setup)', 'subscribe.tsx');
check(subscribe.includes('Scam call protection and unlimited trusted contacts.'), 'Subscribe: reads "Scam call protection and unlimited trusted contacts."');
check(!/AI-powered/i.test(code(subscribe)), 'Subscribe: no "AI-powered" wording');
const screens = ['(setup)/welcome.tsx', '(setup)/complete.tsx', '(setup)/subscribe.tsx', '(setup)/confirmation.tsx', '(auth)/welcome.tsx'];
check(screens.every((f) => !/AI-powered/i.test(code(read('mobile', 'app', ...f.split('/'))))), 'no "AI-powered" wording in the mobile onboarding/auth screens');

// ---- 2. VAT ----
const welcome = read('mobile', 'app', '(setup)', 'welcome.tsx');
const complete = read('mobile', 'app', '(setup)', 'complete.tsx');
check(welcome.includes('detail="£4.99/month including VAT"'), 'mobile welcome: "£4.99/month including VAT"');
check(complete.includes('£4.99 per month including VAT, cancel anytime.'), 'mobile complete: "£4.99 per month including VAT, cancel anytime."');
check(subscribe.includes('<Text style={styles.price}>£4.99/month, including VAT</Text>'), 'Subscribe: the price line still says "£4.99/month, including VAT" (price itself unchanged)');
for (const [file, src] of [['routes/mobileApi.js', read('routes', 'mobileApi.js')], ['server.js', read('server.js')]]) {
  check(src.includes('priceLabel: "£4.99 per month including VAT",') && !src.includes('priceLabel: "£4.99 per month",'), `${file}: Membership priceLabel is "£4.99 per month including VAT" (display string only)`);
}
check(!/4\.99/.test(code(read('services', 'checkoutSession.js')).replace(/You'll be charged £4\.99 today, then £4\.99 every month[^"]*/, '')), 'Stripe checkout session code: only its existing custom_text message mentions the price — no price or config value was changed');

// ---- 3. Guarantee removed from welcome / complete (and not replaced) ----
for (const [name, src] of [['welcome.tsx', welcome], ['complete.tsx', complete]]) {
  check(!/30[- ]day|money[- ]back|guarantee|refund/i.test(code(src)), `mobile ${name}: no 30-day / money-back / guarantee / refund wording`);
}
check(!/Platform/.test(code(complete)), 'mobile complete.tsx: the platform-specific (Apple refund) branch that only served the guarantee line is gone');

// ---- 4. Google Play listing draft ----
const listing = read('docs', 'launch', 'STORE_LISTING_COPY.md');
const play = listing.slice(listing.indexOf('## Google Play Console (Android)'), listing.indexOf('## Notes / open decisions for Andrew'));
const shortDesc = (play.match(/\*\*Short description\*\*[^\n]*\n> (.+)/) || [])[1] || '';
const fullDesc = (play.match(/\*\*Full description\*\*[^\n]*\n```\n([\s\S]*?)\n```/) || [])[1] || '';
check(shortDesc.length > 0 && shortDesc.length <= 80, `Play short description present and within 80 chars (${shortDesc.length})`);
check(fullDesc.length > 0 && fullDesc.length <= 4000, `Play full description present and within 4000 chars (${fullDesc.length})`);
const listingText = `${shortDesc}\n${fullDesc}`;
check(!/before they (ever )?reach/i.test(listingText), 'Play description: no "before they reach you" claim');
check(!/landline or mobile|protects? (your |a )?landline|protect(ing)? a landline/i.test(listingText), 'Play description: no claim that Home Call Guard protects a landline');
check(!/AI-powered|money-back|guarantee of|sms|text message/i.test(listingText), 'Play description: no AI-powered / guarantee / SMS wording');
check(/available now for Android phones\. iPhone and landline support are coming soon\./.test(fullDesc), 'Play description: Android available now; iPhone and landline coming soon');
check(/goes beyond ordinary number blocking[\s\S]{0,140}assesses risk as the conversation develops/.test(fullDesc), 'Play description: positioned as protection beyond number blocking, assessing risk as the call develops');
check(/Android — available now · iPhone — Coming Soon · Landline — Coming Soon/.test(play), 'Play section states availability: Android available now, iPhone and Landline Coming Soon');
check(/£4\.99 a month including VAT/.test(fullDesc), 'Play description: price stated including VAT');
check(/App Store \(iOS\) section is NOT updated/.test(listing.split('## App Store Connect (iOS)')[0]), 'the draft warns that the App Store (iOS) section is outdated and must not be used as-is');

// ---- wiring ----
check(JSON.parse(read('package.json')).scripts.test.includes('node tests/release-copy-corrections.test.mjs'), 'this test is part of the npm test chain');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
