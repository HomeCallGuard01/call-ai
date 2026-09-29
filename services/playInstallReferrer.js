// playInstallReferrer.js — campaign attribution from a website visit through
// a Google Play install to an HCG registration (2026-09-29 prototype).
//
// Mechanism: Google Play's own `referrer` parameter on a Play listing URL.
// Play stores that string and hands it back, once, to the installed app via
// the Play Install Referrer API (read in the app by expo-application's
// getInstallReferrerAsync — mobile/lib/installReferrer.ts). The app then sends
// the three UTM fields with POST /api/v1/register, which records the
// EXISTING cookie-free acquisition events (services/acquisitionAnalytics.js).
//
// Privacy scope, deliberately minimal: ONLY utm_source / utm_medium /
// utm_campaign are ever put into, or read out of, the referrer. No device
// identifier, advertising ID, click ID (gclid/fbclid/ttclid), email or
// visitor ID — and no third-party attribution SDK. Values are restricted to
// a conservative alphabet so a hostile query string cannot smuggle anything
// else into the Play URL or into the database.
'use strict';

const PLAY_LISTING_URL = 'https://play.google.com/store/apps/details?id=co.uk.homecallguard.app';
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign'];
const SAFE_VALUE = /^[A-Za-z0-9._-]{1,100}$/;

function safeValue(v) {
  return typeof v === 'string' && SAFE_VALUE.test(v) ? v : null;
}

// { utmSource, utmMedium, utmCampaign } -> the Play listing URL, with a
// `referrer` parameter carrying only the safe UTM fields present. Returns the
// plain listing URL when there is nothing safe to carry.
function buildPlayListingUrl(utm) {
  const fields = [
    ['utm_source', utm && utm.utmSource],
    ['utm_medium', utm && utm.utmMedium],
    ['utm_campaign', utm && utm.utmCampaign],
  ].filter(([, v]) => safeValue(v));
  if (fields.length === 0) return PLAY_LISTING_URL;
  const referrer = fields.map(([k, v]) => `${k}=${v}`).join('&');
  return `${PLAY_LISTING_URL}&referrer=${encodeURIComponent(referrer)}`;
}

module.exports = { PLAY_LISTING_URL, UTM_KEYS, SAFE_VALUE, buildPlayListingUrl, safeValue };
