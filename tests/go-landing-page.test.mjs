// Tests for the /go landing page (2026-09-21): the permanent "link in
// bio" / QR / press page. AVAILABILITY MUST BE ACCURATE: Android is the
// only product available today. iPhone and Landline are "Coming soon" and
// can only ever join a waiting list — Landline has no route to
// registration, login, the dashboard, checkout or payment from here.
//
// Covers: Android stays available (exact Google Play destination, "Available
// now"); iPhone stays Coming soon with its waiting list, and only becomes a
// live App Store link when BOTH IOS_COMING_SOON=false and a valid
// https://apps.apple.com URL are set (services/goLanding.js, exercised for
// real); Landline shows Coming soon and has no purchase/onboarding route
// (static checks AND the page's own script run against a fake DOM); no
// remaining claim that Landline is available now, or that HCG supports
// both mobile and landline; the waiting-list reasons the page sends are all
// accepted by server.js; UTM forwarding onto "Learn more"; nothing
// prohibited on the page (pricing, login, third-party requests); the brand
// palette/assets; and that server.js still serves it at GET /go and counts
// visits through the EXISTING landing_visit analytics event.
//
// Run with: node tests/go-landing-page.test.mjs

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { renderGoPage, isValidAppStoreUrl } = require('../services/goLanding');
const { KNOWN_EVENT_TYPES } = require('../services/acquisitionAnalytics');

const goSource = readFileSync(path.join(__dirname, '..', 'public', 'go.html'), 'utf8');
const serverSource = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const PLAY = 'https://play.google.com/store/apps/details?id=co.uk.homecallguard.app';
const REAL_LOOKING = 'https://apps.apple.com/gb/app/home-call-guard/id1234567890';

// Helpers over the template.
const withoutComments = (html) => html
  .replace(/<!--[\s\S]*?-->/g, '')          // HTML comments
  .replace(/\/\*[\s\S]*?\*\//g, '')         // CSS / JS block comments
  .replace(/^[ \t]*\/\/.*$/gm, '');          // full-line JS comments (never touches URLs inside strings)
const cardBlock = (html, id) => {
  const start = html.indexOf(`<details class="device soon" id="${id}">`);
  return start === -1 ? '' : html.slice(start, html.indexOf('</details>', start) + '</details>'.length);
};
// The text a visitor can read: no comments, styles, scripts or tags.
const visibleText = (html) => withoutComments(html)
  .replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const TEXT = visibleText(goSource);
const VISIBLE = withoutComments(goSource);   // rendered markup — developer comments may say "no pricing"
const SCRIPT = withoutComments((goSource.match(/<script>([\s\S]*?)<\/script>/) || [, ''])[1]);

// ---- Server wiring ----
const goRoute = serverSource.slice(serverSource.indexOf('app.get("/go"'), serverSource.indexOf('app.get("/go"') + 900);
check(
  serverSource.includes('app.get("/go", (req, res) => {') && goRoute.includes('renderGoPage(GO_TEMPLATE'),
  'server.js still serves the /go URL (existing links keep working), rendered through services/goLanding.js'
);
check(
  serverSource.includes('fs.readFileSync(__dirname + "/public/go.html"'),
  'the template is public/go.html, read once at startup'
);
check(
  goRoute.includes('recordAcquisitionEvent("landing_visit"') && goRoute.includes('path: "/go"') && KNOWN_EVENT_TYPES.includes('landing_visit'),
  'visits are counted with the EXISTING landing_visit event (path "/go") — no new event type, no schema change'
);
check(
  /recordAcquisitionEvent\("landing_visit"[\s\S]*?\}\)\.catch\(\(\) => \{\}\)/.test(goRoute),
  'analytics is fire-and-forget (.catch, never awaited before the response), so it cannot slow or break the page'
);
check(
  goRoute.indexOf('.send(') !== -1 && goRoute.indexOf('.send(') < goRoute.indexOf('recordAcquisitionEvent'),
  'the response is sent before the analytics write is even started'
);

// ---- 1. Android: available now ----
const androidTag = (goSource.match(/<a[^>]*id="android"[^>]*>/) || [''])[0];
check(androidTag.includes(`href="${PLAY}"`), 'Android links to the exact public Google Play listing (co.uk.homecallguard.app)');
check((goSource.match(/play\.google\.com/g) || []).length === 1, 'the Play URL appears exactly once — no second/competing Google destination');
const androidBlock = goSource.slice(goSource.indexOf('id="android"'), goSource.indexOf('<!--APP_STORE_BUTTON_START-->'));
check(androidTag.includes('class="device available"') && androidBlock.includes('<strong>Android</strong>') && androidBlock.includes('<span class="badge">Available now</span>'), 'Android card reads "Android — Available now" and is styled as the available (green) card');
check((TEXT.match(/Available now/g) || []).length === 1, 'in the default page "Available now" appears exactly once — for Android only');

// ---- 2. iPhone: Coming soon, waiting list preserved ----
const DEFAULT_PAGE = renderGoPage(goSource, { iosComingSoon: true, appStoreUrl: undefined });
check(DEFAULT_PAGE === goSource, 'with the flag on and no URL, the page is served exactly as the template — nothing swapped in');
const iphoneBlock = goSource.slice(goSource.indexOf('<!--APP_STORE_BUTTON_START-->'), goSource.indexOf('<!--APP_STORE_BUTTON_END-->'));
check(iphoneBlock.includes('id="iphone"') && iphoneBlock.includes('<strong>iPhone</strong>') && iphoneBlock.includes('<span class="badge">Coming soon</span>'), 'iPhone card reads "iPhone — Coming soon"');
check(iphoneBlock.includes('data-reason="ios_coming_soon"') && iphoneBlock.includes('data-device="iphone"') && iphoneBlock.includes('type="email"'), 'iPhone keeps its waiting-list form, submitting the existing reason ios_coming_soon (deviceType iphone, as the homepage banner does)');
check(!/<a[\s>]/.test(iphoneBlock) && !/href=|action=/.test(iphoneBlock), 'the Coming soon iPhone card has no link, href or form action — it can only reveal the waiting-list form');
check(!goSource.includes('apps.apple.com') && !/itms-apps|itunes\.apple/.test(goSource), 'no Apple URL of any kind exists in the shipped template');

// ---- 2b. iPhone can only go live when BOTH conditions hold ----
const live = renderGoPage(goSource, { iosComingSoon: false, appStoreUrl: REAL_LOOKING });
check(live.includes(`id="iphone" href="${REAL_LOOKING}"`) && live.includes('Download on the App Store') && !live.includes('data-reason="ios_coming_soon"'), 'flag off + valid App Store URL -> the iPhone waiting-list card is replaced by a real App Store link (the waiting-list form is gone)');
check((visibleText(live).match(/Available now/g) || []).length === 2 && !/iPhone[^.]{0,40}Coming soon/.test(visibleText(live)), 'once live, iPhone reads "Available now" (Android + iPhone), not Coming soon');
check(live.includes(`href="${PLAY}"`) && live.includes('data-reason="landline_coming_soon"') && cardBlock(live, 'landline') === cardBlock(goSource, 'landline'), 'going live for Apple leaves Android and the Landline Coming soon card untouched');
check(renderGoPage(goSource, { iosComingSoon: true, appStoreUrl: REAL_LOOKING }) === goSource, 'valid URL but IOS_COMING_SOON still on -> stays Coming soon (Apple cannot be linked early by setting only the URL)');
check(renderGoPage(goSource, { iosComingSoon: false, appStoreUrl: undefined }) === goSource, 'flag off but NO URL -> stays Coming soon (nothing is ever invented)');
check(renderGoPage(goSource, { iosComingSoon: undefined, appStoreUrl: REAL_LOOKING }) === goSource, 'flag value not strictly false (e.g. unset/undefined) -> stays Coming soon (fail closed)');
for (const bad of ['http://apps.apple.com/gb/app/x/id1', 'https://evil.example/apps.apple.com/x', 'https://apps.apple.com.evil.example/x', 'javascript:alert(1)', 'https://apps.apple.com/gb/app/x"><script>alert(1)</script>', 'https://apps.apple.com/', '', '   ']) {
  check(renderGoPage(goSource, { iosComingSoon: false, appStoreUrl: bad }) === goSource && !isValidAppStoreUrl(bad), `rejected as an App Store URL, iPhone stays Coming soon: ${JSON.stringify(bad).slice(0, 60)}`);
}
check(renderGoPage(goSource, { iosComingSoon: false, appStoreUrl: 'https://apps.apple.com/gb/app/x/id1?ct=a&mt=8' }).includes('?ct=a&amp;mt=8'), 'ampersands in a valid URL are HTML-escaped when rendered');

// ---- 3. Landline: Coming soon, no purchase / onboarding route ----
const landlineBlock = cardBlock(goSource, 'landline');
check(landlineBlock.includes('<strong>Landline</strong>') && landlineBlock.includes('<span class="badge">Coming soon</span>'), 'Landline card is visible and reads "Landline — Coming soon"');
check(!landlineBlock.includes('Available now') && !/Protect a landline|Set up Home Call Guard|Get started|Get protected|Subscribe|Sign up/i.test(landlineBlock), 'the Landline card has no "available"/"set up"/"protect"/"subscribe" call to action');
check(!/<a[\s>]/.test(landlineBlock) && !/href=|action=/.test(landlineBlock), 'the Landline card has no link, href or form action at all — nothing to navigate to');
check(landlineBlock.includes('data-reason="landline_coming_soon"') && landlineBlock.includes('data-device="landline"') && landlineBlock.includes('type="email"'), 'Landline joins the waiting list with its OWN reason (landline_coming_soon, deviceType landline) — never the iPhone reason');
check(!landlineBlock.includes('ios_coming_soon'), 'Landline interest cannot be recorded as iPhone interest (iPhone data stays uncorrupted)');
check(landlineBlock.includes("Landline support is coming soon.") && !/works with|every landline|no app|without an app|phone company|provider|forward|divert/i.test(landlineBlock), 'Landline wording is only "coming soon" — no unverified claim about how it works or which landlines it will support');
const allHrefs = [...withoutComments(goSource).matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((m) => m[1]);
check(JSON.stringify(allHrefs) === JSON.stringify([PLAY, '/', '/privacy', '/terms.html']), `the ONLY <a> links on the page are Google Play, the homepage, Privacy and Terms (found: ${allHrefs.join(', ')})`);
check(!/\/register|\/dashboard|\/login|\/subscribe|\/billing|\/checkout|\/onboarding|\/confirm|\/activate|\/upload/i.test(VISIBLE.replace(/data-[a-z-]+="[^"]*"/g, '')), 'no reference to registration, login, dashboard, billing, checkout, subscribe or onboarding routes anywhere in the page');
check(!/stripe|checkout|payment|subscribe|£|\bper month\b|\/month|\bpric/i.test(VISIBLE), 'no Stripe/checkout/payment/subscribe/pricing reference anywhere on the page');
check(!/<form[^>]*\baction=/i.test(goSource) && !/<form[^>]*\bmethod=/i.test(goSource), 'the forms have no action or method — they cannot submit anywhere natively (no-JS fallback is a message, not a route)');
check(!/location|window\.open|history\.|\.href\s*=|navigate|assign\(|replace\(/.test(SCRIPT), 'the page script never navigates (no location/window.open/history/href assignment)');
const urlLiterals = [...SCRIPT.matchAll(/['"](\/[^'"]*|https?:[^'"]*)['"]/g)].map((m) => m[1]);
check(JSON.stringify([...new Set(urlLiterals)]) === JSON.stringify(['/api/v1/waiting-list']), `the script's only URL is the waiting-list endpoint (found: ${[...new Set(urlLiterals)].join(', ')})`);

// ---- 4. No remaining claim that Landline is available / that both are supported ----
check(!/landline/i.test(TEXT.replace(visibleText(landlineBlock), '')), 'the word "landline" appears ONLY inside the Landline Coming soon card — nowhere else on the page (title, description, lead, links)');
check(!/landline/i.test(withoutComments(goSource.replace(landlineBlock, ''))), 'no landline mention in the page head/meta/og tags/other markup either (outside the Coming soon card)');
check(!/(mobile|android|phone)s?[^.<]{0,25}\band\b[^.<]{0,25}landline|landlines?[^.<]{0,25}\band\b[^.<]{0,25}(mobile|android|phone)|both (mobile|android)|any (phone|landline)/i.test(TEXT), 'nothing says or implies HCG supports both mobile and landline');
check(!/landline[^.]{0,60}(available now|available today|is available|works|supported now|set up|protected)/i.test(TEXT), 'no sentence says Landline is available, works, or can be set up');

// ---- 5. Behaviour: the page's own script, run against a fake DOM ----
function makeListener() {
  const listeners = {};
  return { listeners, addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); }, fire(t, ev = {}) { (listeners[t] || []).forEach((f) => f(ev)); } };
}
function makeForm(reason, device, success) {
  const email = { value: '', disabled: false, focused: false, focus() { this.focused = true; } };
  const button = { disabled: false, hidden: false };
  const msg = { textContent: '', className: 'msg' };
  const attrs = { 'data-reason': reason, 'data-device': device, 'data-success': success };
  return Object.assign(makeListener(), {
    email, button, msg,
    getAttribute: (n) => attrs[n],
    querySelector: (sel) => (sel === 'input' ? email : sel === 'button' ? button : sel === '.msg' ? msg : null),
  });
}
function makeCard(form) {
  return Object.assign(makeListener(), { open: false, form, querySelector: (sel) => (sel === 'input' ? form.email : null) });
}
async function runPage(fetchImpl) {
  const iphoneForm = makeForm('ios_coming_soon', 'iphone', 'iphone ok');
  const landlineForm = makeForm('landline_coming_soon', 'landline', 'landline ok');
  const cards = [makeCard(iphoneForm), makeCard(landlineForm)];
  const fetchCalls = [];
  const sandbox = {
    document: { querySelectorAll: (sel) => (sel === 'details.device' ? cards : sel === 'form.wait' ? [iphoneForm, landlineForm] : []) },
    fetch: (url, opts) => { fetchCalls.push({ url, opts, body: JSON.parse(opts.body) }); return fetchImpl(); },
    Array, JSON, Error, Promise,
    // no `location`, `window` or `history` provided: any navigation attempt would throw a ReferenceError
  };
  vm.runInNewContext(SCRIPT, sandbox);
  const settle = () => new Promise((r) => setImmediate(r));
  return { iphoneForm, landlineForm, cards, fetchCalls, settle };
}
const okFetch = () => Promise.resolve({ ok: true });

{
  const p = await runPage(okFetch);
  p.landlineForm.email.value = '  ll@example.com ';
  p.landlineForm.fire('submit', { preventDefault() {} });
  await p.settle();
  check(p.fetchCalls.length === 1 && p.fetchCalls[0].url === '/api/v1/waiting-list' && p.fetchCalls[0].opts.method === 'POST', 'submitting the Landline form makes exactly ONE request: POST /api/v1/waiting-list');
  check(JSON.stringify(p.fetchCalls[0].body) === JSON.stringify({ email: 'll@example.com', reason: 'landline_coming_soon', deviceType: 'landline' }), 'the Landline request body is exactly { email, reason: "landline_coming_soon", deviceType: "landline" } — clearly identified as Landline interest');
  check(p.landlineForm.msg.textContent === 'landline ok' && p.landlineForm.msg.className === 'msg success' && p.landlineForm.button.hidden === true && p.landlineForm.email.disabled === true, 'a saved Landline signup shows the Landline thank-you message and locks the form');
}
{
  const p = await runPage(okFetch);
  p.iphoneForm.email.value = 'ip@example.com';
  p.iphoneForm.fire('submit', { preventDefault() {} });
  await p.settle();
  check(p.fetchCalls.length === 1 && JSON.stringify(p.fetchCalls[0].body) === JSON.stringify({ email: 'ip@example.com', reason: 'ios_coming_soon', deviceType: 'iphone' }), 'the iPhone waiting list still posts { email, reason: "ios_coming_soon", deviceType: "iphone" } — unchanged, same shape as the homepage banner');
  check(p.iphoneForm.msg.textContent === 'iphone ok' && p.landlineForm.msg.textContent === '', 'iPhone success does not touch the Landline form');
}
{
  const p = await runPage(okFetch);
  p.landlineForm.email.value = 'not-an-email';
  p.landlineForm.fire('submit', { preventDefault() {} });
  await p.settle();
  check(p.fetchCalls.length === 0 && p.landlineForm.msg.className === 'msg error' && /valid email/i.test(p.landlineForm.msg.textContent), 'an invalid email sends nothing and shows an error');
}
{
  const p = await runPage(() => Promise.resolve({ ok: false }));
  p.landlineForm.email.value = 'll@example.com';
  p.landlineForm.fire('submit', { preventDefault() {} });
  await p.settle();
  check(p.landlineForm.msg.className === 'msg error' && p.landlineForm.button.disabled === false && p.landlineForm.email.disabled === false, 'a failed save shows an error and lets the visitor retry');
}
{
  const p = await runPage(okFetch);
  p.cards[0].open = true; p.cards[0].fire('toggle');
  p.cards[1].open = true; p.cards[1].fire('toggle');
  check(p.cards[0].open === false && p.cards[1].open === true && p.landlineForm.email.focused === true, 'only one Coming soon card stays open at a time (keeps the page short in in-app browsers), and the email field is focused');
}
{
  // Every reason the page can send must be one the server accepts.
  const allowed = [...(serverSource.match(/const WAITING_LIST_REASONS = new Set\(\[([^\]]+)\]\)/) || [, ''])[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const pageReasons = [...goSource.matchAll(/data-reason="([^"]+)"/g)].map((m) => m[1]);
  check(pageReasons.length === 2 && pageReasons.every((r) => allowed.includes(r)), `every waiting-list reason the page sends (${pageReasons.join(', ')}) is accepted by server.js's allow-list (${allowed.join(', ')})`);
  check(allowed.includes('ios_coming_soon') && allowed.includes('unsupported_carrier'), 'the existing iPhone and unsupported-carrier reasons are still accepted — nothing removed');
  const wlIdx = serverSource.indexOf('app.post("/api/v1/waiting-list"');
  const wlBlock = serverSource.slice(wlIdx, serverSource.indexOf('\napp.', wlIdx + 10));
  check(!/stripe|revenuecat|twilio|entitlement|subscription|checkout/i.test(wlBlock) && !/requireAuth/.test(wlBlock), 'the waiting-list route (which now also serves Landline) never touches Stripe/RevenueCat/Twilio/entitlements and needs no login');
  check(wlBlock.includes('reason === "unsupported_carrier" && typeof providerKey'), 'providerKey is still only stored for unsupported_carrier — Landline/iPhone rows never carry one');
}

// ---- 6. UTM attribution: forwarded onto "Learn more" only ----
const learnTag = (goSource.match(/<a[^>]*id="learnMore"[^>]*>/) || [''])[0];
check(/<a class="learn" id="learnMore" href="\/">Learn more about Home Call Guard<\/a>/.test(goSource), '"Learn more about Home Call Guard" links to the main website home page');
check(renderGoPage(goSource, { iosComingSoon: true, utm: {} }) === goSource && renderGoPage(goSource, { iosComingSoon: true }) === goSource, 'no UTM parameters -> the page is served exactly as the template');
const withUtm = renderGoPage(goSource, { iosComingSoon: true, utm: { utmSource: 'tiktok', utmMedium: 'bio', utmCampaign: 'launch' } });
check(withUtm.includes('id="learnMore" href="/?utm_source=tiktok&amp;utm_medium=bio&amp;utm_campaign=launch"'), 'UTM parameters are forwarded onto the "Learn more" homepage link, so a social visitor who reads the homepage and registers later is still attributed to the source');
const utmHrefs = [...withoutComments(withUtm).matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((m) => m[1]);
check(utmHrefs.length === 4 && utmHrefs[0] === PLAY && utmHrefs[2] === '/privacy' && utmHrefs[3] === '/terms.html' && !utmHrefs.some((h) => /register|dashboard|login/.test(h)), 'with UTMs, only the Learn more link changes — Google Play, Privacy and Terms are untouched and no registration/login link appears');
const hostile = renderGoPage(goSource, { iosComingSoon: true, utm: { utmSource: '"><script>alert(1)</script>', utmMedium: 'a&b', utmCampaign: "x'y" } });
const hostileLearn = (hostile.match(/<a[^>]*id="learnMore"[^>]*>/) || [''])[0];
check(hostileLearn === '<a class="learn" id="learnMore" href="/?utm_source=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E&amp;utm_medium=a%26b&amp;utm_campaign=x\'y">' && (hostile.match(/<script>/g) || []).length === 1, 'hostile UTM values are percent-encoded on the Learn more link: still one well-formed <a>, and no markup or extra script is injected');
const withStray = renderGoPage(goSource, { iosComingSoon: true, utm: { utmSource: 'tiktok', ttclid: 'abc', fbclid: 'x', email: 'a@b.c' } });
check(!/ttclid|fbclid|a@b\.c|email=/.test(withStray) && withStray.includes('id="learnMore" href="/?utm_source=tiktok"'), 'only utm_source/utm_medium/utm_campaign are ever forwarded — no other parameter reaches any link');
check(renderGoPage(goSource, { iosComingSoon: false, appStoreUrl: REAL_LOOKING, utm: { utmSource: 'tiktok' } }).includes('href="/?utm_source=tiktok"'), 'going live for Apple does not disturb the Learn more UTM forwarding');

// ---- 7. Content: only what was asked for; claim cleanup ----
check(goSource.includes('Home Call <span>Guard</span>') && goSource.includes('Another layer of protection for you and your family.') && goSource.includes('Protect yourself and the people you care about from scam calls.'), 'shows the Home Call Guard name and the two approved messages');
check(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(goSource), 'no emoji');
check((goSource.match(/<script/g) || []).length === 1 && !/src=["']?[^>]*\.js/.test(goSource), 'exactly one inline script (the waiting-list submit handler) and no external script files');
check(!/(src|href)="https?:\/\/(?!play\.google\.com\/store\/apps\/details\?id=co\.uk\.homecallguard\.app")/.test(goSource.replace(/<meta[^>]*>/g, '')), 'no third-party requests: the only absolute link is the Play listing (og:image is a meta tag, not fetched by the page)');
check(!/login|sign in|sign-in|signin/i.test(TEXT), 'no login or sign-in path on the page');
check(!/before (they|it|a scam|scam)[^.<]{0,25}reach|reach(es)? you before|stops? (scam|nuisance)|stopped before/i.test(VISIBLE), 'no "before they (ever) reach you" or "stops scam and nuisance calls" claim anywhere on the page');
check(!/\band why\b|what was screened/i.test(VISIBLE), 'no "exactly what was screened and why" claim');
check(!/no delays?|without delay/i.test(VISIBLE), 'no "with no delays" claim');
check(!/traffic[- ]light|risk rating|risk level|low risk|possible risk|high risk/i.test(VISIBLE), 'no three-level / traffic-light risk-rating claim');
check(!/no app|app required|without (the|an) app|works with every|every phone/i.test(TEXT), 'no unverified promises ("no app required", "works with every ...")');

// ---- 8. Order, brand, assets ----
const iAndroid = goSource.indexOf('id="android"'), iApple = goSource.indexOf('<!--APP_STORE_BUTTON_START-->'), iLand = goSource.indexOf('id="landline"'), iLearn = goSource.indexOf('id="learnMore"'), iFoot = goSource.indexOf('<footer>');
check(iAndroid < iApple && iApple < iLand && iLand < iLearn && iLearn < iFoot, 'order: Android, iPhone, Landline, Learn more, then Privacy/Terms footer');
check(goSource.includes('--bg: #050a07') && goSource.includes('--green: #3cf07a'), 'HCG black/green palette (#050a07 background, #3cf07a accent)');
check(goSource.includes('src="/hcg-shield.png"') && existsSync(path.join(__dirname, '..', 'public', 'hcg-shield.png')), 'uses the genuine HCG shield/phone mark (public/hcg-shield.png exists)');
function pngSize(file) {
  const b = readFileSync(path.join(__dirname, '..', 'public', file));
  return b.slice(1, 4).toString() === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null;
}
for (const d of ['android', 'iphone', 'landline']) {
  const size = existsSync(path.join(__dirname, '..', 'public', `go-icon-${d}.png`)) ? pngSize(`go-icon-${d}.png`) : null;
  check(goSource.includes(`src="/go-icon-${d}.png"`) && size && size[0] === 96 && size[1] === 96, `the ${d} card uses the real ${d} device mark (public/go-icon-${d}.png, 96×96 PNG, palette-matched copy of ${d}-device-mark.png)`);
}
check(!/emoji|&#x1F|&#128/i.test(goSource), 'device cards use image icons, never emoji or generic glyphs');
check(/<meta name="viewport" content="width=device-width, initial-scale=1/.test(goSource) && goSource.includes('lang="en-GB"'), 'mobile-first viewport and en-GB language');
check(existsSync(path.join(__dirname, '..', 'public', 'logo.png')), 'og:image asset (public/logo.png) still exists');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
