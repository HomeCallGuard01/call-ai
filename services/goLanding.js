// goLanding.js — renders public/go.html (the permanent "link in bio" /
// QR / press landing page) with the iPhone card in the right state.
//
// AVAILABILITY (2026-09-21): Android is the only live product. The iPhone
// and Landline cards are "Coming soon" waiting-list cards. By default
// there is NO landline route into registration/dashboard/checkout.
//
// LANDLINE_COMING_SOON (2026-09-21, services/featureFlags.js): the
// Landline card ships as a "Coming soon" waiting-list card. This module
// only ever swaps it for a live landline link when landlineComingSoon is
// the boolean `false` (i.e. LANDLINE_COMING_SOON is exactly "false") —
// any other value, including undefined, fails closed and the page is
// returned byte-for-byte as the template. That switch exists so landline
// can be deliberately re-enabled later without rebuilding this design;
// the live link is kept here, not deleted. Otherwise this module only
// touches the iPhone card and the "Learn more" link.
//
// The template ships with the iPhone card in its "Coming soon" waiting-list
// state (an email form, never a purchase route). This module only swaps
// in a live App Store link when BOTH are true:
//   1. IOS_COMING_SOON is explicitly "false" (services/featureFlags.js —
//      the same single switch the website, waiting list and mobile app
//      already use to mean "Apple has approved the app"), AND
//   2. APP_STORE_URL is a well-formed https://apps.apple.com/... URL.
// Anything else — flag still on, no URL, a malformed URL, a URL on any
// other host — leaves the safe "Coming soon" waiting-list card. Nothing
// here ever invents or defaults an Apple URL.
'use strict';

const START = '<!--APP_STORE_BUTTON_START-->';
const END = '<!--APP_STORE_BUTTON_END-->';
const LANDLINE_START = '<!--LANDLINE_BUTTON_START-->';
const LANDLINE_END = '<!--LANDLINE_BUTTON_END-->';

// Strict on purpose: https only, apps.apple.com only, and a conservative
// path/query alphabet — so a mistyped or hostile env value can never
// inject markup or point the button anywhere but the App Store.
const APP_STORE_URL_PATTERN = /^https:\/\/apps\.apple\.com\/[A-Za-z0-9\/_.\-%]+(\?[A-Za-z0-9_.\-%=&]+)?$/;

function isValidAppStoreUrl(url) {
  return typeof url === 'string' && url.length <= 300 && APP_STORE_URL_PATTERN.test(url);
}

// The live iPhone card: same layout as the Android card, an actual link to
// the App Store, marked "Available now". Replaces the whole "Coming soon"
// waiting-list card (including its form) — they never appear together.
function liveAppStoreButton(url) {
  const safe = url.replace(/&/g, '&amp;');
  return (
    '<a class="device available" id="iphone" href="' + safe + '" rel="noopener">\n' +
    '      <img class="d-icon" src="/go-icon-iphone.png" width="32" height="32" alt="">\n' +
    '      <span class="d-text"><strong>iPhone</strong><span>Download on the App Store</span></span>\n' +
    '      <span class="badge">Available now</span>\n' +
    '    </a>'
  );
}

// utm_* forwarding. Only the three UTM fields the analytics system already
// records are ever forwarded — never any other query parameter — and each
// value is percent-encoded and HTML-escaped, so a hostile query string
// cannot alter the link.
//
// They are forwarded onto "Learn more" (the homepage, "/"): a
// visitor who reads the homepage first and registers afterwards is still
// attributed to the social source, because the homepage forwards its own
// query string onto its "get protected" buttons and records its own
// landing_visit with the UTMs. TRADE-OFF (explicitly approved by the owner,
// 2026-09-20: retaining the original social acquisition source through to
// registration is preferred over an exact raw landing-visit count): that
// visitor counts as two landing_visit events (one for /go, one for /).
// Landing counts are documented as raw page requests, not unique visitors,
// whereas without forwarding the source of a later registration would be
// lost. To revert, delete LEARN_MORE_LINK and its replace() below plus the
// matching checks in tests/go-landing-page.test.mjs.
const LEARN_MORE_LINK = 'id="learnMore" href="/"';

function utmQuery(utm) {
  if (!utm) return '';
  const pairs = [['utm_source', utm.utmSource], ['utm_medium', utm.utmMedium], ['utm_campaign', utm.utmCampaign]]
    .filter(([, v]) => typeof v === 'string' && v.length > 0)
    .map(([k, v]) => k + '=' + encodeURIComponent(v));
  return pairs.length ? '?' + pairs.join('&amp;') : '';
}

// The live landline card (only ever rendered when landline is deliberately
// re-enabled): same layout as the Android/iPhone live cards, a plain link
// into the EXISTING new-customer entry point, /register.html, with utm_*
// forwarded so registration keeps its social attribution. Deliberately NO
// waiting-list form and NO data-reason — a live card and the waiting-list
// card never appear together.
function liveLandlineButton(q) {
  return (
    '<a class="device available" id="landline" href="/register.html' + q + '" rel="noopener">\n' +
    '      <img class="d-icon" src="/go-icon-landline.png" width="32" height="32" alt="">\n' +
    '      <span class="d-text"><strong>Landline</strong><span>Set up Home Call Guard for your home phone</span></span>\n' +
    '      <span class="badge">Available now</span>\n' +
    '    </a>'
  );
}

function renderGoPage(template, { iosComingSoon, appStoreUrl, utm, landlineComingSoon }) {
  let html = template;
  const q = utmQuery(utm);
  if (q && html.includes(LEARN_MORE_LINK)) {
    html = html.replace(LEARN_MORE_LINK, 'id="learnMore" href="/' + q + '"');
  }
  // Landline: live ONLY when the flag is strictly the boolean false.
  if (landlineComingSoon === false) {
    const lStart = html.indexOf(LANDLINE_START);
    const lEnd = html.indexOf(LANDLINE_END);
    if (lStart !== -1 && lEnd !== -1 && lEnd > lStart) {
      html = html.slice(0, lStart) + liveLandlineButton(q) + '\n    ' + html.slice(lEnd + LANDLINE_END.length);
    }
  }
  if (iosComingSoon !== false || !isValidAppStoreUrl(appStoreUrl)) return html;
  const start = html.indexOf(START);
  const end = html.indexOf(END);
  if (start === -1 || end === -1 || end < start) return html;
  return html.slice(0, start) + liveAppStoreButton(appStoreUrl) + '\n    ' + html.slice(end + END.length);
}

module.exports = { renderGoPage, isValidAppStoreUrl, APP_STORE_URL_PATTERN, utmQuery };
