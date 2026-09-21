// Website + /go + integration-contract proof for LANDLINE_COMING_SOON (2026-09-21).
//
// The BACKEND decision is authoritative and is proven in
// tests/landline-coming-soon-backend.test.mjs (real route handlers, Stripe
// stand-in). This file proves the customer-facing web surfaces follow it and
// FAIL CLOSED, and that the integration introduced no second gate:
//
//   1. upload.html (web onboarding): Landline is "Coming soon"; the page opens
//      landline ONLY on an explicit `landlineComingSoon === false` from
//      /api/v1/launch-flags (a 2xx object). An error, timeout, non-2xx,
//      malformed body, missing field — or ANY response to the "record the
//      choice" request (including a 400) — can never make landline available.
//      The choice is recorded with provider "other" so the route contract is
//      untouched. The page keys on `reason`, never on a customerState the
//      server does not send.
//   2. /go (executed): the Landline card is Coming soon unless
//      landlineComingSoon is the boolean false.
//   3. Public website (homepage, 12 guides, support): nothing presents
//      landline as available.
//   4. One gate only: providerPolicy.js is the sole control-flow decision;
//      routes contain none; the superseded state name is nowhere; no migration.
//
// Run with: node tests/website-landline-coming-soon.test.mjs

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const read = (...p) => readFileSync(path.join(root, ...p), 'utf8');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

// ============================================================
// 1. upload.html — web onboarding
// ============================================================
const html = read('upload.html');
check(/<span class="option-card-label" id="carrierLandlineLabel">Landline — Coming soon<\/span>/.test(html), 'upload.html: the Landline device card reads "Landline — Coming soon"');
check(html.includes('id="landlineComingSoonMessage"') && html.includes('Home Call Guard for landlines is coming soon') && html.includes("we can't take a subscription for a landline today"), 'upload.html: a "Landline is coming soon" panel exists and says landline cannot be bought today');
check(/let landlineComingSoon = true;/.test(html) && html.indexOf('let landlineComingSoon = true;') < html.indexOf('function landlineSelectableForActivation'), 'upload.html: the state DEFAULTS to Coming soon (fail closed) and is declared before anything reads it');

// -- the launch-flags fetch: the ONLY way landline can open --
const flagsFetch = html.slice(html.indexOf('fetch("/api/v1/launch-flags")'), html.indexOf('if (checkCarrierButtonEl) {\n    checkCarrierButtonEl.addEventListener("click", evaluateCarrierCompatibility);'));
check(flagsFetch.includes('if (!r.ok) throw new Error("launch-flags " + r.status);'), 'launch-flags fetch: a non-2xx response is an ERROR (never parsed as an answer)');
check(flagsFetch.includes('landlineComingSoon = !(flags !== null && typeof flags === "object" && flags.landlineComingSoon === false);'), 'launch-flags fetch: opens ONLY for an object whose landlineComingSoon is the boolean false — a string "false", 0, null, {} or a missing field all stay Coming soon');
check(/\.catch\(function \(\) \{\s*landlineComingSoon = true;\s*applyLandlineAvailabilityToUi\(\);\s*\}\);/.test(flagsFetch), 'launch-flags fetch: ANY failure (network, timeout, malformed JSON) explicitly sets Coming soon');

// -- every write to the state variable --
const writers = [...html.matchAll(/^[ \t]*landlineComingSoon\s*=\s*([^;]+);/gm)].map((m) => m[1].trim());
const allowedWriters = ['true', '!(flags !== null && typeof flags === "object" && flags.landlineComingSoon === false)'];
check(writers.length === 3 && writers.every((w) => allowedWriters.includes(w)) && writers.filter((w) => w !== 'true').length === 1, `the page assigns landlineComingSoon in exactly 3 places (server-reason => true, launch-flags parse, error => true); the ONLY route to false is the explicit launch-flags check (found: ${JSON.stringify(writers.map((w) => (w.length > 20 ? 'launch-flags parse' : w)))})`);
check(!/landlineComingSoon\s*=\s*false/.test(html), 'no assignment of literal false anywhere');

// -- recording the choice can never open landline --
const enterFn = html.slice(html.indexOf('function enterLandlineComingSoon()'), html.indexOf('function applyLandlineAvailabilityToUi()'));
check(enterFn.includes('body: JSON.stringify({ deviceType: "landline", provider: "other" })'), 'enterLandlineComingSoon records the choice with provider "other" (a valid landline provider value — the backend route contract is untouched)');
check(!/\.then\(/.test(enterFn) && !/status\s*===?\s*400/.test(enterFn) && !/landlineComingSoon\s*=/.test(enterFn), 'enterLandlineComingSoon IGNORES the response: no .then, no 400-handling, no assignment — a 400 (or anything else) can never make landline available');
check(!enterFn.includes('handleCarrierCheckSuccess') && !enterFn.includes('termsConsentSectionEl') && !enterFn.includes('subscribeFormEl'), 'enterLandlineComingSoon never reveals the consent section or the Stripe subscribe form');
check(enterFn.includes('checkCarrierButtonEl.hidden = true') && enterFn.includes('carrierLandlineProviderRowEl.hidden = true') && enterFn.includes('landlineComingSoonMessageEl.hidden = false'), 'entering Coming soon hides Continue and the provider question and shows the explanation');

// -- the page keys on the real server contract --
check(!/customerState\s*===\s*["']landline_coming_soon["']/.test(html), 'the page never keys on customerState "landline_coming_soon" — a state the authoritative server does not send');
check(/if \(result\.reason === "landline_coming_soon"\) \{\s*landlineComingSoon = true;/.test(html), 'capture result: the page keys on reason "landline_coming_soon" and only ever moves TOWARD Coming soon');
const recheck = html.slice(html.indexOf('termsConsentErrorEl.textContent = result.customerState === "ios_coming_soon"'), html.indexOf('termsConsentErrorEl.hidden = false;', html.indexOf('termsConsentErrorEl.textContent = result.customerState === "ios_coming_soon"')));
check(recheck.indexOf('result.reason === "landline_coming_soon"') !== -1 && recheck.indexOf('result.reason === "landline_coming_soon"') < recheck.indexOf('result.customerState === "landline_provider_unsupported"'), 'last-moment re-check before Stripe: Coming soon (by reason) is tested BEFORE the generic landline_provider_unsupported message');

// -- ordering / preserved implementation / post-payment chooser --
const evalFn = html.slice(html.indexOf('async function evaluateCarrierCompatibility()'), html.indexOf('if (checkCarrierButtonEl) {\n    checkCarrierButtonEl.addEventListener("click", evaluateCarrierCompatibility);'));
const stop = evalFn.indexOf('&& landlineComingSoon) {');
check(stop !== -1 && evalFn.slice(stop, stop + 200).includes('enterLandlineComingSoon();') && evalFn.slice(stop, stop + 200).includes('return;') && stop < evalFn.indexOf('rememberDeviceCategory(') && stop < evalFn.indexOf('handleCarrierCheckSuccess();', evalFn.indexOf('!isMobile')), 'evaluateCarrierCompatibility: a landline choice while Coming soon hard-stops BEFORE it is remembered, before any provider round trip and before the only path that reveals Stripe');
check(html.includes('id="carrierLandlineProviderRow"') && html.includes('landline_provider_unsupported') && html.includes('LANDLINE_SUPPORTED_PROVIDERS'), 'the landline provider row and supported-provider handling are still in the page (implementation preserved for when the flag is off)');
check(/function landlineSelectableForActivation\(\) \{\s*return !landlineComingSoon \|\| !!\(lastDashboardData && lastDashboardData\.deviceType === "landline"\);/.test(html), 'post-payment chooser: "Home landline" is offered only when landline is open OR the household is already a landline household (existing customers keep working)');
check(/if \(deviceType === "landline" && !landlineSelectableForActivation\(\)\)/.test(html), 'a stale/hand-edited landline selection is rejected before any activation code is requested');
check(!html.includes('LANDLINE_COMING_SOON_FLAG.md') && html.includes('LANDLINE_COMING_SOON_LAUNCH_FLAG.md'), 'upload.html points at the authoritative doc (LANDLINE_COMING_SOON_LAUNCH_FLAG.md)');

// ============================================================
// 2. /go — executed, default and fail-closed
// ============================================================
const { renderGoPage } = require('../services/goLanding.js');
const goTemplate = read('public', 'go.html');
const comingSoonCard = (out) => out.includes('data-reason="landline_coming_soon"') && !/id="landline" href="\/register\.html/.test(out);
const liveCard = (out) => /<a class="device available" id="landline" href="\/register\.html/.test(out) && !out.includes('data-reason="landline_coming_soon"');
check(comingSoonCard(goTemplate), '/go template as shipped: the Landline card is a Coming-soon waiting-list card, with no route into registration');
for (const [label, value] of [['undefined (flag absent)', undefined], ['null', null], ['true', true], ['string "false"', 'false'], ['number 0', 0], ['empty string', ''], ['{}', {}], ['NaN', NaN], ['string "true"', 'true']]) {
  const out = renderGoPage(goTemplate, { iosComingSoon: true, appStoreUrl: undefined, utm: {}, landlineComingSoon: value });
  check(comingSoonCard(out) && !liveCard(out), `/go: landlineComingSoon = ${label} => Landline stays Coming soon (fail closed)`);
}
{
  const out = renderGoPage(goTemplate, { iosComingSoon: true, appStoreUrl: undefined, utm: {}, landlineComingSoon: false });
  check(liveCard(out), '/go: only the boolean false swaps in the live landline card (the deliberate restore path)');
}
{
  const out = renderGoPage(goTemplate, { iosComingSoon: true, appStoreUrl: undefined, utm: {}, landlineComingSoon: true });
  check(out.includes('play.google.com/store/apps/details?id=co.uk.homecallguard.app') && out.includes('data-reason="ios_coming_soon"') && out.includes('data-reason="landline_coming_soon"'), '/go default: Android links to Google Play; iPhone and Landline both offer waiting lists (ios_coming_soon / landline_coming_soon)');
  check(!/<a[^>]*href="\/(register|dashboard|login)/.test(out), '/go default: no link into registration, login or the dashboard anywhere on the page');
}
const serverSrc = read('server.js');
check(/landlineComingSoon: isLandlineComingSoon\(\),\s*\n\s*appStoreUrl/.test(serverSrc) || serverSrc.includes('landlineComingSoon: isLandlineComingSoon()'), 'server: the /go render receives the REAL flag value (never hard-coded)');
check(serverSrc.includes('const WAITING_LIST_REASONS = new Set(["ios_coming_soon", "unsupported_carrier", "landline_coming_soon"]);'), 'server: waiting-list reasons are ios_coming_soon, unsupported_carrier and landline_coming_soon');

// ============================================================
// 3. Public website — nothing presents landline as available
// ============================================================
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
const visible = (s) => strip(s).replace(/<[^>]+>/g, '\n').replace(/[ \t]+/g, ' ');
const home = read('public', 'index.html');
const homeVisible = visible(home);
check(!/href="\/register\.html"/.test(strip(home)), 'homepage: no link to /register.html remains (the only landline sign-up route)');
check(!/Protect a landline|Set up Home Call Guard for your home phone/.test(homeVisible), 'homepage: no "Protect a landline" call to action');
check(!/Call Divert|BT, Sky|Sign-up currently accepts|Works with BT/.test(homeVisible), 'homepage: no landline provider list or Call Divert fee note');
const landlineTiles = [...strip(home).matchAll(/<(\w+)[^>]*data-landline-soon[^>]*>/g)];
check(landlineTiles.length === 4 && landlineTiles.every((m) => m[1] === 'div'), 'homepage: Landline appears as 4 non-clickable "Coming soon" tiles — all <div>, none a link');
check(/Can I use Home Call Guard on my landline\?[\s\S]{0,200}Not yet\. Landline protection is coming soon and we aren't selling it today/.test(home), 'homepage FAQ: "Can I use Home Call Guard on my landline?" => "Not yet … we aren\'t selling it today"');
const homeLandlineLines = homeVisible.split('\n').filter((l) => /landline/i.test(l)).map((l) => l.trim()).filter(Boolean);
check(homeLandlineLines.length > 0 && homeLandlineLines.every((l) => /coming soon|^Landline$|Can I use Home Call Guard on my landline\?|working on iPhone and landline support|Not yet|available for Android/i.test(l)), `homepage: EVERY visible mention of landline says coming soon / not available (${homeLandlineLines.length} mentions)`);
check(home.includes('href="https://play.google.com/store/apps/details?id=co.uk.homecallguard.app"') && !/data-app-store[^>]*href/.test(strip(home)), 'homepage: Google Play links to the real listing; the App Store tile is a non-link "Coming soon"');
check(/£4\.99 a month, including VAT/.test(home), 'homepage: £4.99 is shown VAT-inclusive');
check(!home.includes('LANDLINE_COMING_SOON_FLAG.md'), 'homepage: no reference to the superseded doc');

const guidesDir = path.join(root, 'public', 'guides');
const guideFiles = readdirSync(guidesDir).filter((f) => f.endsWith('.html') && f !== 'index.html');
let ctaGuides = 0;
for (const f of guideFiles) {
  const g = readFileSync(path.join(guidesDir, f), 'utf8');
  const cta = (g.match(/<div class="hcg-cta">[\s\S]*?<\/div>/) || [''])[0];
  if (!cta) continue;
  ctaGuides++;
  const text = cta.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  check(/Android/.test(text) && /coming soon/i.test(text), `guide ${f}: its Home Call Guard block says Android is available and landline/iPhone are coming soon`);
  check(!/no app/i.test(g.replace(/<style[\s\S]*?<\/style>/g, '')), `guide ${f}: no "no app needed/required" claim`);
}
check(ctaGuides === 12, 'all 12 guides that promote Home Call Guard were checked');
for (const f of ['stop-scam-calls-on-a-landline-uk.html', 'protect-an-elderly-persons-landline.html']) {
  const g = readFileSync(path.join(guidesDir, f), 'utf8');
  const cta = (g.match(/<div class="hcg-cta">[\s\S]*?<\/div>/) || [''])[0];
  check(!/href="\/register\.html"/.test(cta) && /<span class="hcg-cta-secondary">Landline support is coming soon<\/span>/.test(cta), `landline guide ${f}: no sign-up link — the call to action is the text "Landline support is coming soon"`);
}
const support = visible(read('public', 'support.html'));
check(!/BT, Sky|Virgin or TalkTalk/.test(support) && /Landline protection is coming soon and isn't available to new\s*customers yet\./.test(support.replace(/\n/g, ' ')), 'support page: no landline provider list; landline protection is coming soon and not available to new customers');

// Static scan: no sentence anywhere on the public site affirmatively claims Home Call Guard works on a landline today.
const AFFIRM = /(Home Call Guard|HCG)\s+(now\s+)?(protects|works (on|with)|supports)\s+(your\s+|a\s+)?(landline|home phone)|(protect|set up|sign up for)\s+(a|your)\s+landline\s+(now|today)|landline\s+(protection\s+)?is\s+(now\s+)?available/i;
const publicPages = [];
(function walk(dir) { for (const n of readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, n.name); if (n.isDirectory()) walk(p); else if (p.endsWith('.html')) publicPages.push(p); } })(path.join(root, 'public'));
publicPages.push(path.join(root, 'upload.html'));
const affirmative = [];
for (const p of publicPages) for (const line of visible(readFileSync(p, 'utf8')).split('\n')) if (AFFIRM.test(line) && !/not (yet )?available|isn't available|coming soon/i.test(line)) affirmative.push(`${path.relative(root, p)}: ${line.trim().slice(0, 100)}`);
check(affirmative.length === 0, `static scan (${publicPages.length} pages): no sentence affirmatively claims landline is available${affirmative.length ? ' — found: ' + affirmative.join(' | ') : ''}`);

// ============================================================
// 4. One gate only; superseded contract absent; no schema change
// ============================================================
const policySrc = read('services', 'providerPolicy.js');
check((policySrc.match(/isLandlineComingSoon\(\)/g) || []).length === 1, 'providerPolicy.js contains exactly ONE landline Coming-soon gate — no duplicate');
check(policySrc.includes('customerState: "landline_provider_unsupported"') && policySrc.includes('reason: "landline_coming_soon"') && !/status:\s*"landline_coming_soon"|customerState:\s*"landline_coming_soon"/.test(policySrc), 'the gate returns customerState landline_provider_unsupported with reason landline_coming_soon (the approved compatibility contract)');
for (const f of ['billing.js', 'mobileApi.js']) {
  const src = read('routes', f);
  check(!/isLandlineComingSoon|landline_coming_soon/.test(src), `routes/${f}: no landline flag logic — provider validation on the capture routes is unchanged (the website's provider-optional relaxation was deliberately NOT ported)`);
}
check((serverSrc.match(/isLandlineComingSoon\(\)/g) || []).length === (serverSrc.match(/landlineComingSoon: isLandlineComingSoon\(\)/g) || []).length && (serverSrc.match(/isLandlineComingSoon\(\)/g) || []).length === 2, 'server.js: the flag is only a read-only pass-through into two responses (launch-flags, /go render) — never a control-flow gate');
const migrations = readdirSync(path.join(root, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql'));
check(!migrations.some((f) => /landline_coming_soon/i.test(readFileSync(path.join(root, 'supabase', 'migrations', f), 'utf8'))) && migrations.filter((f) => /waiting/i.test(f)).length === 1, 'no waiting-list schema/migration change for landline (reason is open text; migration 042 is the only waiting-list migration)');
check(!existsSync(path.join(root, 'docs', 'launch', 'LANDLINE_COMING_SOON_FLAG.md')) && existsSync(path.join(root, 'docs', 'launch', 'LANDLINE_COMING_SOON_LAUNCH_FLAG.md')), 'exactly one flag doc: LANDLINE_COMING_SOON_LAUNCH_FLAG.md (the superseded duplicate is not present)');

const chain = JSON.parse(read('package.json')).scripts.test.split('&&').map((s) => s.trim());
check(new Set(chain).size === chain.length, `npm test chain has no duplicate entries (${chain.length} files)`);
check(chain.every((c) => existsSync(path.join(root, c.replace(/^node /, '')))), 'every test named in the npm test chain exists');
for (const t of ['landline-coming-soon-backend', 'mobile-landline-coming-soon', 'website-landline-coming-soon', 'go-landing-page']) {
  check(chain.includes(`node tests/${t}.test.mjs`), `npm test runs tests/${t}.test.mjs`);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
