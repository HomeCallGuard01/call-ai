// Public website — commercial facts regression (2026-09-27, launch-ready pass).
//
// Pins the few things that must stay true on the public site, without pinning
// individual sentences:
//   1. One price: £4.99 a month including VAT — shown in the hero (before the
//      first download link) and at the pricing/decision point, and nowhere
//      contradicted (no other monthly price, no tiers, no public minute
//      allowance/fair-use proposition).
//   2. No over-claiming: no "100%", "guaranteed", "stops every scam" style claims.
//   3. The "can't catch every scam" qualification lives once, in the FAQ — not in
//      the sales sections — and the superseded repeated caveats are gone.
//   4. No technical/provider language in customer-facing marketing pages.
//
// Run with: node tests/website-commercial-facts.test.mjs

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(path.join(root, ...p), 'utf8');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
const visible = (s) => strip(s).replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·').replace(/\s+/g, ' ');
const section = (html, id) => {
  const start = html.search(new RegExp(`<section[^>]*id="${id}"`));
  return start === -1 ? '' : html.slice(start, html.indexOf('</section>', start));
};

const home = read('public', 'index.html');
const homeText = visible(home);
const PLAY = 'https://play.google.com/store/apps/details?id=co.uk.homecallguard.app';

// ---------- 1. price ----------
const hero = home.slice(home.indexOf('<section class="hero">'), home.indexOf('</section>', home.indexOf('<section class="hero">')));
const heroText = visible(hero);
check(/£4\.99 a month, including VAT/.test(heroText), 'hero: shows "£4.99 a month, including VAT"');
check(hero.indexOf('£4.99') !== -1 && hero.indexOf('£4.99') < hero.indexOf(PLAY), 'hero: the price appears before the first download link');

const pricing = section(home, 'pricing');
check(/£4\.99 a month, including VAT/.test(visible(pricing)) && pricing.includes(`href="${PLAY}"`), 'pricing section: £4.99 including VAT sits with the Google Play download link (the decision point)');

const homePrices = [...homeText.matchAll(/£\s?(\d+(?:\.\d{2})?)/g)].map((m) => m[1]);
check(homePrices.length >= 2 && homePrices.every((p) => p === '4.99'), `homepage: every visible price is £4.99 (found: ${homePrices.join(', ')})`);

const ld = JSON.parse(home.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
const offer = ld['@graph'].find((n) => n['@type'] === 'Service').offers;
check(offer.price === '4.99' && offer.priceCurrency === 'GBP' && offer.priceSpecification.valueAddedTaxIncluded === true && offer.priceSpecification.billingDuration === 'P1M', 'structured data: one offer, £4.99/month, VAT included');

const meta = (home.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
check(/£4\.99 a month including VAT/.test(meta), 'meta description: states £4.99 a month including VAT');

check(!/\b(Basic|Plus|Premium|Family plan|Pro plan)\b/.test(homeText), 'homepage: no Basic/Plus/Premium or other tier names');
check(!/\b(minutes|allowance|fair[- ]use)\b/i.test(homeText), 'homepage: no public minute allowance / fair-use proposition');

// Across the whole public site: any "£X a month / per month / /month" price is £4.99.
const publicPages = [];
(function walk(dir) { for (const n of readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, n.name); if (n.isDirectory()) walk(p); else if (p.endsWith('.html')) publicPages.push(p); } })(path.join(root, 'public'));
const wrongMonthly = [];
for (const p of publicPages) {
  // Sentences quoting a phone company's own charges (e.g. a network's Call Divert fee
  // in a landline guide) are third-party prices, not ours, and are skipped.
  for (const sentence of visible(readFileSync(p, 'utf8')).split(/(?<=[.!?])\s+/)) {
    if (/\b(BT|Sky|Virgin|TalkTalk|Vodafone|EE|O2|Three|giffgaff)\b/.test(sentence)) continue;
    for (const m of sentence.matchAll(/£\s?(\d+(?:\.\d{2})?)\s*(?:a month|per month|\/\s?month|\/mo\b)/gi)) {
      if (m[1] !== '4.99') wrongMonthly.push(`${path.relative(root, p)}: ${m[0]}`);
    }
  }
}
check(wrongMonthly.length === 0, `public site (${publicPages.length} pages): no monthly price other than £4.99${wrongMonthly.length ? ' — found: ' + wrongMonthly.join(' | ') : ''}`);

// ---------- 2. no over-claiming ----------
const OVERCLAIM = /100\s?%|guarantee[ds]?\b|(stops|blocks|catches|detects) (every|all) scam|never miss(es)? a scam|scam[- ]proof|complete protection|total protection/i;
check(!OVERCLAIM.test(homeText), 'homepage: no 100% / guaranteed / "stops every scam" style claims');

// ---------- 3. qualification placed once, in the FAQ ----------
const faq = section(home, 'faq');
check(/Will it stop every scam call\?/.test(faq) && /No service can promise that/.test(visible(faq)), 'FAQ: the "no service can stop every scam" qualification is answered there');
const outsideFaq = visible(home.replace(faq, ''));
check(!/can.t promise|no service can promise|can.t guarantee|not every call/i.test(outsideFaq), 'sales sections: the qualification is not repeated outside the FAQ');
for (const phrase of [
  'Good to know.',
  "can't promise to catch every scam",
  "doesn't block or delay a call before it reaches your phone",
  'Both matter.',
  'There\'s no fixed length of time',
  'nuisance',
]) {
  check(!homeText.includes(phrase), `homepage: superseded wording removed — "${phrase}"`);
}
check(!/class="final"/.test(home), 'homepage: the separate final-CTA block is merged into Pricing (download tiles not repeated a third time)');

// ---------- 3b. one subscription = one phone (no family-plan implication) ----------
// There is no family plan: nothing on the homepage or /go (including metadata)
// may suggest one £4.99 subscription protects several people.
const FAMILY = /you and your family|your family from|whole family|family plan|family package|loved ones|someone you care about|the people you care about|everyone in your (home|household)/i;
const go = read('public', 'go.html');
// strip() drops HTML comments (the maintainers' notes) but keeps tag attributes, so
// meta descriptions / og: tags are still checked.
check(!FAMILY.test(strip(home)) && !FAMILY.test(strip(go)), 'homepage and /go (incl. metadata): no wording implying one subscription covers a family or other people');
check(/Does one subscription cover more than one phone\?/.test(faq) && /one phone number/.test(visible(faq)), 'FAQ: states plainly that each subscription protects one phone number');
check(/<h1>[^<]*your mobile phone[^<]*<\/h1>/.test(home), 'hero headline is singular and product-specific (your mobile phone)');

// ---------- 3c. 2026-09-28 pass: differentiator, one decision point, no unverifiable status ----------
check(/(call-blocking|caller-ID)[^.]*check the number/i.test(heroText) && /checks the conversation/.test(heroText), 'hero: says in one line how it differs from blocking/caller-ID apps (they check the number; HCG also checks the conversation)');
check(/How is this different from a call-blocking or caller-ID app\?/.test(faq), 'FAQ: answers "How is this different from a call-blocking or caller-ID app?"');
const pricingLinks = [...pricing.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map((m) => m[1]).filter((h) => !h.startsWith('#'));
check(JSON.stringify(pricingLinks) === JSON.stringify([PLAY]) && !/data-landline-soon/.test(pricing), `pricing: the decision point has exactly one outbound action, Google Play, and no repeated Landline tile (found: ${pricingLinks.join(', ')})`);
for (const [name, html] of [['homepage', home], ['/go', go]]) {
  check(!/App Store approval|awaiting approval|waiting for (final )?(Apple|App Store)/i.test(visible(html)), `${name}: no App Review status claimed that the page can't verify`);
}
check(!/querySelectorAll\(['"]a\[href="\/register\.html"\]/.test(home), 'homepage: no dead /register.html query-string passthrough left in the page script');

// ---------- 4. no technical / provider language on marketing pages ----------
const TECH = /\b(Twilio|Media Streams?|Voice SDK|WebSockets?|LLMs?|OpenAI|Deepgram|Anthropic|Supabase|Stripe|carrier routing|AI-powered)\b/;
const marketing = [path.join(root, 'public', 'index.html'), path.join(root, 'public', 'go.html'), path.join(root, 'public', 'support.html'),
  ...readdirSync(path.join(root, 'public', 'guides')).filter((f) => f.endsWith('.html')).map((f) => path.join(root, 'public', 'guides', f))];
const techHits = marketing.filter((p) => TECH.test(visible(readFileSync(p, 'utf8')))).map((p) => path.relative(root, p));
check(techHits.length === 0, `marketing pages (${marketing.length}): no technical/provider jargon${techHits.length ? ' — found in: ' + techHits.join(', ') : ''}`);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
