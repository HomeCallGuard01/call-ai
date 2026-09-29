// Pure parser for the Google Play install-referrer string (2026-09-29
// prototype) — kept free of React Native imports so it can be unit-tested
// directly (tests/play-install-referrer-attribution.test.mjs).
//
// Play returns the `referrer` value from the listing URL the visitor came
// from (services/playInstallReferrer.js builds it), e.g.
//   "utm_source=website&utm_medium=homepage"
// or, for an organic Play install, Play's own default
//   "utm_source=google-play&utm_medium=organic".
// ONLY utm_source / utm_medium / utm_campaign are kept, each restricted to
// the same conservative alphabet the server accepts. Anything else in the
// string (gclid, arbitrary keys) is dropped, never stored or sent.

export type InstallAttribution = {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
};

const SAFE_VALUE = /^[A-Za-z0-9._-]{1,100}$/;
const KEYS = ["utm_source", "utm_medium", "utm_campaign"] as const;

export function parseInstallReferrer(raw: unknown): InstallAttribution | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1000) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const out: InstallAttribution = {};
  for (const key of KEYS) {
    const value = params.get(key);
    if (value !== null && SAFE_VALUE.test(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}
