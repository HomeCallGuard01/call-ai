// Install attribution prototype (2026-09-29): website campaign -> Google Play
// `referrer` -> app (Play Install Referrer via expo-application) ->
// POST /api/v1/register -> existing acquisition events.
//
// Covers:
//   1. services/playInstallReferrer.js builds a Play URL carrying ONLY safe
//      UTM fields, and nothing when there's nothing safe to carry.
//   2. mobile/lib/installReferrerParse.ts (imported directly — Node strips
//      the TypeScript types) keeps only utm_source/medium/campaign, drops
//      click IDs and unsafe values.
//   3. Round trip: what the website builds, the app parses back unchanged.
//   4. /go wiring: Android Play link carries the referrer only when UTMs exist.
//   5. Structural: the app reads Play's referrer via expo-application on
//      Android only, sends it with registerAccount, and /api/v1/register
//      records the existing events fire-and-forget with sanitised UTMs.
//
// Run with: node tests/play-install-referrer-attribution.test.mjs

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PLAY_LISTING_URL, buildPlayListingUrl, safeValue } = require('../services/playInstallReferrer.js');
const { renderGoPage } = require('../services/goLanding.js');
const { parseInstallReferrer } = await import('../mobile/lib/installReferrerParse.ts');
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

// ---- 1. URL builder ----
check(PLAY_LISTING_URL === 'https://play.google.com/store/apps/details?id=co.uk.homecallguard.app', 'the Play listing URL is the real HCG listing');
check(buildPlayListingUrl(undefined) === PLAY_LISTING_URL && buildPlayListingUrl({}) === PLAY_LISTING_URL, 'no UTMs -> the plain listing URL');
const built = buildPlayListingUrl({ utmSource: 'website', utmMedium: 'homepage', utmCampaign: 'launch-2026' });
check(built === PLAY_LISTING_URL + '&referrer=' + encodeURIComponent('utm_source=website&utm_medium=homepage&utm_campaign=launch-2026'), 'UTMs -> Play `referrer` parameter, URL-encoded, UTM fields only');
check(buildPlayListingUrl({ utmSource: '"><script>', utmMedium: 'a&b=c', utmCampaign: 'x'.repeat(101) }) === PLAY_LISTING_URL, 'unsafe values (markup, &/=, over-long) are dropped entirely, never encoded into the link');
check(buildPlayListingUrl({ utmSource: 'tiktok', utmMedium: 'bad value' }) === PLAY_LISTING_URL + '&referrer=' + encodeURIComponent('utm_source=tiktok'), 'a mix keeps only the safe fields');
check(safeValue('google-play') === 'google-play' && safeValue('') === null && safeValue(null) === null && safeValue('a b') === null, 'safeValue: conservative alphabet only');

// ---- 2. app-side parser ----
check(JSON.stringify(parseInstallReferrer('utm_source=google-play&utm_medium=organic')) === JSON.stringify({ utm_source: 'google-play', utm_medium: 'organic' }), "parses Play's organic default referrer");
check(JSON.stringify(parseInstallReferrer('utm_source=website&gclid=abc123&utm_campaign=launch&email=a@b.c')) === JSON.stringify({ utm_source: 'website', utm_campaign: 'launch' }), 'keeps only UTM fields — click IDs and any other keys are dropped');
check(parseInstallReferrer('utm_source=%3Cscript%3E') === null, 'unsafe decoded values are dropped');
check(parseInstallReferrer('') === null && parseInstallReferrer(null) === null && parseInstallReferrer(undefined) === null && parseInstallReferrer(42) === null && parseInstallReferrer('x'.repeat(1001)) === null, 'empty / non-string / oversized input -> null, never throws');

// ---- 3. round trip ----
const referrerParam = new URL(built).searchParams.get('referrer');
check(JSON.stringify(parseInstallReferrer(referrerParam)) === JSON.stringify({ utm_source: 'website', utm_medium: 'homepage', utm_campaign: 'launch-2026' }), 'round trip: the referrer the website builds is parsed back to the same three fields');

// ---- 4. /go wiring ----
const goSource = src('../public/go.html');
check(renderGoPage(goSource, { iosComingSoon: true, utm: {} }) === goSource, '/go without UTMs is still served byte-for-byte as the template');
const goUtm = renderGoPage(goSource, { iosComingSoon: true, utm: { utmSource: 'tiktok', utmMedium: 'bio', utmCampaign: 'launch' } });
check(goUtm.includes('id="android" href="' + PLAY_LISTING_URL + '&amp;referrer=' + encodeURIComponent('utm_source=tiktok&utm_medium=bio&utm_campaign=launch') + '"'), '/go with UTMs: the Android card carries the Play referrer (HTML-escaped)');
const hostile = renderGoPage(goSource, { iosComingSoon: true, utm: { utmSource: '"><script>alert(1)</script>' } });
check(!hostile.includes('<script>alert') && hostile.includes('id="android" href="' + PLAY_LISTING_URL + '"'), '/go with a hostile UTM: Android link stays the plain listing URL, no markup injected');

// ---- 5. structural wiring ----
const installReferrer = src('../mobile/lib/installReferrer.ts');
check(/Platform\.OS !== "android"\) return null/.test(installReferrer) && installReferrer.includes('Application.getInstallReferrerAsync()') && installReferrer.includes('parseInstallReferrer('), 'app: reads Play Install Referrer via expo-application, Android only, through the pure parser');
check(!/getAndroidId|advertising|getIosIdForVendor|androidId/i.test(installReferrer.replace(/^\s*\/\/.*$/gm, '')), 'app: no device or advertising identifier is read');
const mobilePkg = JSON.parse(src('../mobile/package.json'));
check(!!mobilePkg.dependencies['expo-application'] && !Object.keys(mobilePkg.dependencies).some((d) => /appsflyer|adjust|branch|segment|amplitude|mixpanel|firebase-analytics/i.test(d)), 'app: uses the existing expo-application dependency; no third-party attribution/analytics SDK');
const api = src('../mobile/lib/api.ts');
const reg = api.slice(api.indexOf('export async function registerAccount'), api.indexOf('export async function resendConfirmationEmail'));
check(reg.includes('getInstallAttribution().catch(() => null)') && reg.includes('...(attribution ?? {})'), 'app: registerAccount sends the attribution when present and never fails because of it');
const mobileApi = src('../routes/mobileApi.js');
const route = mobileApi.slice(mobileApi.indexOf('router.post("/api/v1/register", async'), mobileApi.indexOf('router.post("/api/v1/register/resend"'));
check(/recordAcquisitionEvent\("registration_submitted", \{ path: "\/api\/v1\/register"[^)]*\}\)\.catch\(\(\) => \{\}\)/.test(route), 'server: /api/v1/register records registration_submitted fire-and-forget (never awaited)');
check(/result\.status === "pending_confirmation" && result\.user\)[\s\S]{0,200}recordAcquisitionEvent\("registration_completed"/.test(route), 'server: registration_completed only for a genuinely new account');
check(/utmSource: safeValue\(rawUtm\.utmSource\)/.test(route) && !/await recordAcquisitionEvent/.test(route), 'server: UTMs re-sanitised server-side with the same safe alphabet; analytics never awaited');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
