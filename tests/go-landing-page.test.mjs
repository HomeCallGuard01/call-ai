// Tests for the /go landing page (2026-09-20 redesign): the permanent
// "link in bio" / QR / press page. It is a NAVIGATION page only — Google
// Play, an App Store button that stays a disabled "Coming soon" until
// Apple is genuinely live, and a landline route into the EXISTING
// sign-up journey.
//
// Covers: the exact Google Play destination; the Apple button is disabled
// and non-linking by default and can only become a link when BOTH
// IOS_COMING_SOON=false and a valid https://apps.apple.com URL are set
// (services/goLanding.js, exercised for real); nothing prohibited on the
// page (pricing, login, email capture, JavaScript, third-party requests);
// the brand palette/asset; and that server.js still serves it at GET /go
// and counts visits through the EXISTING landing_visit analytics event.
//
// Run with: node tests/go-landing-page.test.mjs

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
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

// ---- Google Play ----
check(goSource.includes(`href="${PLAY}"`), 'Google Play button links to the exact public HCG listing (co.uk.homecallguard.app)');
check((goSource.match(/play\.google\.com/g) || []).length === 1, 'the Play URL appears exactly once — no second/competing Google destination');

// ---- Apple: disabled by default ----
const DEFAULT_PAGE = renderGoPage(goSource, { iosComingSoon: true, appStoreUrl: undefined });
check(DEFAULT_PAGE === goSource, 'with the flag on and no URL, the page is served exactly as the template — nothing swapped in');
const appleBlock = goSource.slice(goSource.indexOf('<!--APP_STORE_BUTTON_START-->'), goSource.indexOf('<!--APP_STORE_BUTTON_END-->'));
check(appleBlock.includes('aria-disabled="true"') && appleBlock.includes('Coming soon on the') && appleBlock.includes('App Store'), 'the App Store option reads "Coming soon on the App Store" and is marked aria-disabled');
check(!/<a[\s>]/.test(appleBlock) && !/href=/.test(appleBlock), 'the disabled App Store option is not an <a> and has no href — it cannot navigate anywhere');
check(!goSource.includes('apps.apple.com') && !/itms-apps|itunes\.apple/.test(goSource), 'no Apple URL of any kind exists in the shipped template');
check(/\.store\.disabled\s*\{[^}]*pointer-events:\s*none/.test(goSource), 'the disabled option has pointer-events: none (and no tab stop, since it is not a link)');

// ---- Apple: can only go live when BOTH conditions hold ----
const live = renderGoPage(goSource, { iosComingSoon: false, appStoreUrl: REAL_LOOKING });
check(live.includes(`href="${REAL_LOOKING}"`) && live.includes('Download on the') && !live.includes('Coming soon on the'), 'flag off + valid App Store URL -> a real "Download on the App Store" link replaces the disabled button');
check(live.includes(`href="${PLAY}"`) && live.replace(/<!--APP_STORE_BUTTON_(START|END)-->/g, '').includes('Google Play'), 'going live for Apple leaves the Google Play button untouched');
check(renderGoPage(goSource, { iosComingSoon: true, appStoreUrl: REAL_LOOKING }) === goSource, 'valid URL but IOS_COMING_SOON still on -> stays disabled (Apple cannot be linked early by setting only the URL)');
check(renderGoPage(goSource, { iosComingSoon: false, appStoreUrl: undefined }) === goSource, 'flag off but NO URL -> stays disabled (nothing is ever invented)');
check(renderGoPage(goSource, { iosComingSoon: undefined, appStoreUrl: REAL_LOOKING }) === goSource, 'flag value not strictly false (e.g. unset/undefined) -> stays disabled (fail closed)');
for (const bad of ['http://apps.apple.com/gb/app/x/id1', 'https://evil.example/apps.apple.com/x', 'https://apps.apple.com.evil.example/x', 'javascript:alert(1)', 'https://apps.apple.com/gb/app/x"><script>alert(1)</script>', 'https://apps.apple.com/', '', '   ']) {
  check(renderGoPage(goSource, { iosComingSoon: false, appStoreUrl: bad }) === goSource && !isValidAppStoreUrl(bad), `rejected as an App Store URL, button stays disabled: ${JSON.stringify(bad).slice(0, 60)}`);
}
check(renderGoPage(goSource, { iosComingSoon: false, appStoreUrl: 'https://apps.apple.com/gb/app/x/id1?ct=a&mt=8' }).includes('?ct=a&amp;mt=8'), 'ampersands in a valid URL are HTML-escaped when rendered');

// ---- Content: only what was asked for ----
check(goSource.includes('Home Call <span>Guard</span>') && goSource.includes('Another layer of protection for you and your family.') && goSource.includes('Protect yourself and the people you care about from scam calls.'), 'shows the Home Call Guard name and the two approved messages');
const VISIBLE = goSource.replace(/<!--[\s\S]*?-->/g, '');   // rendered content only — developer comments may say "no pricing"
check(!/£|\bper month\b|\/month|\bpric/i.test(VISIBLE), 'no pricing anywhere on the page');
check(!/<input|<form|<textarea|<select|type="email"/i.test(goSource), 'no email/form fields — nothing to fill in');
check(!/login|sign in|sign-in|signin|\/dashboard|waiting/i.test(VISIBLE), 'no login, sign-in, dashboard or waiting-list path (the only sign-up route is the landline link, below)');
check(!/<script/i.test(goSource), 'zero JavaScript on the page');
check(!/(src|href)="https?:\/\/(?!play\.google\.com\/store\/apps\/details\?id=co\.uk\.homecallguard\.app")/.test(goSource.replace(/<meta[^>]*>/g, '')), 'no third-party requests: the only absolute link is the Play listing (og:image is a meta tag, not fetched by the page)');
check(!/stripe|checkout/i.test(goSource), 'no Stripe/checkout reference');
check(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(goSource), 'no emoji');
check((goSource.match(/<a\b/g) || []).length === 5, 'exactly 5 links in the template: Google Play, Protect a landline, Learn more, Privacy, Terms (the App Store link exists only once swapped in live)');


// ---- Landline: the EXISTING sign-up route, not an invented one ----
const landlineTag = (goSource.match(/<a[^>]*id="landline"[^>]*>/) || [''])[0];
check(landlineTag.includes('href="/register.html"'), 'Protect a landline links to /register.html — the existing new-customer entry point');
check(goSource.includes('<strong>Protect a landline</strong>') && goSource.includes('Set up Home Call Guard for your home phone'), 'landline option carries the exact approved wording');
const registerHtml = readFileSync(path.join(__dirname, '..', 'public', 'register.html'), 'utf8');
const indexHtml = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
check(existsSync(path.join(__dirname, '..', 'public', 'register.html')) && indexHtml.includes('href="/register.html"'), '/register.html exists and is the same destination the homepage "get protected" buttons already use — no new URL, no duplicate onboarding flow');
check(registerHtml.includes('utm_source') && registerHtml.includes('URLSearchParams(window.location.search)'), 'register.html reads utm_* from its own query string, so forwarding UTMs to it keeps registration attribution');
check(!/href="\/dashboard/.test(goSource), 'does not use /dashboard (auth-gated: a logged-out visitor is redirected to the LOGIN page, not sign-up — the old /go landline link had this flaw)');
const LL = 'id="landline" href="/register.html"';
check(renderGoPage(goSource, { iosComingSoon: true, utm: {} }) === goSource && renderGoPage(goSource, { iosComingSoon: true }) === goSource, 'no UTM parameters -> the landline link stays the plain /register.html');
const withUtm = renderGoPage(goSource, { iosComingSoon: true, utm: { utmSource: 'tiktok', utmMedium: 'bio', utmCampaign: 'launch' } });
check(withUtm.includes('href="/register.html?utm_source=tiktok&amp;utm_medium=bio&amp;utm_campaign=launch"'), 'UTM parameters are forwarded onto the landline sign-up link (server-side, no JavaScript)');
const hostile = renderGoPage(goSource, { iosComingSoon: true, utm: { utmSource: '"><script>alert(1)</script>', utmMedium: 'a&b', utmCampaign: "x'y" } });
const hostileTag = (hostile.match(/<a[^>]*id="landline"[^>]*>/) || [''])[0];
check(!hostile.includes('<script') && hostileTag === '<a class="store alt" id="landline" href="/register.html?utm_source=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E&amp;utm_medium=a%26b&amp;utm_campaign=x\'y" rel="noopener">', 'hostile UTM values are percent-encoded: the landline tag is exactly one well-formed <a> and no markup can be injected');
check(withUtm.includes('id="learnMore" href="/?utm_source=tiktok&amp;utm_medium=bio&amp;utm_campaign=launch"'), 'UTMs are ALSO forwarded onto the "Learn more" homepage link, so a visitor who reads the homepage first and registers later is still attributed to the social source');
const hostileLearn = (hostile.match(/<a[^>]*id="learnMore"[^>]*>/) || [''])[0];
check(hostileLearn === '<a class="learn" id="learnMore" href="/?utm_source=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E&amp;utm_medium=a%26b&amp;utm_campaign=x\'y">' && (hostile.match(/<a\b/g) || []).length === 5, 'hostile UTM values are percent-encoded on the Learn more link too: still exactly one well-formed <a>, no injected markup');
const noUtmLearn = renderGoPage(goSource, { iosComingSoon: true, utm: {} });
check(noUtmLearn.includes('id="learnMore" href="/"') && noUtmLearn === goSource, 'no UTM parameters -> Learn more stays the plain "/" (page unchanged)');
const withStray = renderGoPage(goSource, { iosComingSoon: true, utm: { utmSource: 'tiktok', ttclid: 'abc', fbclid: 'x', email: 'a@b.c' } });
check(!/ttclid|fbclid|a@b\.c|email=/.test(withStray) && withStray.includes('id="learnMore" href="/?utm_source=tiktok"'), 'only utm_source/utm_medium/utm_campaign are ever forwarded — no other parameter reaches either link');
check(renderGoPage(goSource, { iosComingSoon: false, appStoreUrl: REAL_LOOKING, utm: { utmSource: 'tiktok' } }).includes('utm_source=tiktok') , 'going live for Apple does not disturb the landline UTM forwarding');

// ---- Learn more: a small secondary link to the main website ----
check(/<a class="learn" id="learnMore" href="\/">Learn more about Home Call Guard<\/a>/.test(goSource), '"Learn more about Home Call Guard" links to the main website home page');
check(/\.learn\s*\{[^}]*font-size:\s*0\.9rem[^}]*color:\s*var\(--muted\)/.test(goSource) && !/class="learn[^"]*store/.test(goSource), 'Learn more is styled as small muted text, not a button competing with the store buttons');

// ---- Hierarchy / order ----
const iGoogle = goSource.indexOf('id="googlePlay"'), iApple = goSource.indexOf('<!--APP_STORE_BUTTON_START-->'), iLand = goSource.indexOf('id="landline"'), iLearn = goSource.indexOf('id="learnMore"'), iFoot = goSource.indexOf('<footer>');
check(iGoogle < iApple && iApple < iLand && iLand < iLearn && iLearn < iFoot, 'order: Google Play, App Store, Protect a landline, Learn more, then Privacy/Terms footer');

// ---- Claims that must not appear (claim cleanup: see report) ----
check(!/before (they|it|a scam|scam)[^.<]{0,25}reach|reach(es)? you before|stops? (scam|nuisance)|stopped before/i.test(VISIBLE), 'no "before they (ever) reach you" or "stops scam and nuisance calls" claim anywhere on the page');
check(!/\band why\b|what was screened/i.test(VISIBLE), 'no "exactly what was screened and why" claim');
check(!/no delays?|without delay/i.test(VISIBLE), 'no "with no delays" claim');
check(!/traffic[- ]light|risk rating|risk level|low risk|possible risk|high risk/i.test(VISIBLE), 'no three-level / traffic-light risk-rating claim');

// ---- Brand ----
check(goSource.includes('--bg: #050a07'), 'near-black #050a07 background');
check(goSource.includes('src="/hcg-shield.png"') && existsSync(path.join(__dirname, '..', 'public', 'hcg-shield.png')), 'uses the genuine HCG shield/phone mark (public/hcg-shield.png exists)');
check(/<meta name="viewport" content="width=device-width, initial-scale=1/.test(goSource) && goSource.includes('lang="en-GB"'), 'mobile-first viewport and en-GB language');
check(existsSync(path.join(__dirname, '..', 'public', 'logo.png')), 'og:image asset (public/logo.png) still exists');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
