// goLanding.js — renders public/go.html (the permanent "link in bio" /
// QR / press download landing page) with the App Store button in the
// right state.
//
// The template ships with the App Store button in its DISABLED
// ("Coming soon on the App Store", not a link) state. This module only
// swaps in a live link when BOTH are true:
//   1. IOS_COMING_SOON is explicitly "false" (services/featureFlags.js —
//      the same single switch the website, waiting list and mobile app
//      already use to mean "Apple has approved the app"), AND
//   2. APP_STORE_URL is a well-formed https://apps.apple.com/... URL.
// Anything else — flag still on, no URL, a malformed URL, a URL on any
// other host — leaves the safe disabled button. Nothing here ever
// invents or defaults an Apple URL.
'use strict';

const START = '<!--APP_STORE_BUTTON_START-->';
const END = '<!--APP_STORE_BUTTON_END-->';

// Strict on purpose: https only, apps.apple.com only, and a conservative
// path/query alphabet — so a mistyped or hostile env value can never
// inject markup or point the button anywhere but the App Store.
const APP_STORE_URL_PATTERN = /^https:\/\/apps\.apple\.com\/[A-Za-z0-9\/_.\-%]+(\?[A-Za-z0-9_.\-%=&]+)?$/;

function isValidAppStoreUrl(url) {
  return typeof url === 'string' && url.length <= 300 && APP_STORE_URL_PATTERN.test(url);
}

function liveAppStoreButton(url) {
  const safe = url.replace(/&/g, '&amp;');
  return (
    '<a class="store" id="appStore" href="' + safe + '" rel="noopener">\n' +
    '      <small>Download on the</small>\n' +
    '      <strong>App Store</strong>\n' +
    '    </a>'
  );
}

// The landline route is the existing new-customer entry point,
// /register.html (the same destination as every "Get protected" button on
// the homepage; register.html reads utm_* from its own query string so a
// TikTok/QR source is attributed all the way to registration). Only the
// three UTM fields the analytics system already records are forwarded —
// never any other query parameter — and each value is percent-encoded and
// HTML-escaped, so a hostile query string cannot alter the link.
//
// The same UTMs are forwarded onto "Learn more" (the homepage, "/"): a
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
const LANDLINE_LINK = 'id="landline" href="/register.html"';
const LEARN_MORE_LINK = 'id="learnMore" href="/"';

function utmQuery(utm) {
  if (!utm) return '';
  const pairs = [['utm_source', utm.utmSource], ['utm_medium', utm.utmMedium], ['utm_campaign', utm.utmCampaign]]
    .filter(([, v]) => typeof v === 'string' && v.length > 0)
    .map(([k, v]) => k + '=' + encodeURIComponent(v));
  return pairs.length ? '?' + pairs.join('&amp;') : '';
}

function renderGoPage(template, { iosComingSoon, appStoreUrl, utm }) {
  let html = template;
  const q = utmQuery(utm);
  if (q && html.includes(LANDLINE_LINK)) {
    html = html.replace(LANDLINE_LINK, 'id="landline" href="/register.html' + q + '"');
  }
  if (q && html.includes(LEARN_MORE_LINK)) {
    html = html.replace(LEARN_MORE_LINK, 'id="learnMore" href="/' + q + '"');
  }
  if (iosComingSoon !== false || !isValidAppStoreUrl(appStoreUrl)) return html;
  const start = html.indexOf(START);
  const end = html.indexOf(END);
  if (start === -1 || end === -1 || end < start) return html;
  return html.slice(0, start) + liveAppStoreButton(appStoreUrl) + '\n    ' + html.slice(end + END.length);
}

module.exports = { renderGoPage, isValidAppStoreUrl, APP_STORE_URL_PATTERN, utmQuery };
