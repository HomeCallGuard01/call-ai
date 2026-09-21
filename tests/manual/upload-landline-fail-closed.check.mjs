// MANUAL real-browser check (not part of `npm test`; needs Chrome + playwright-core).
// Loads the REAL upload.html in Chrome and drives /api/v1/launch-flags through
// every failure mode, asserting Landline is available ONLY on an explicit
// landlineComingSoon === false. Also proves a 400 from the "record the choice"
// request can never open landline and that the choice is sent with provider "other".
//
// Run:  [UPLOAD_HTML=/path/to/another/upload.html] PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node tests/manual/upload-landline-fail-closed.check.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const html = readFileSync(process.env.UPLOAD_HTML || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'upload.html'), 'utf8');

const ORIGIN = 'http://hcg.test';
const OPEN_LABEL = 'Landline';
const CLOSED_LABEL = 'Landline — Coming soon';

async function run(browser, name, flagsHandler, { expectOpen, afterLoad } = {}) {
  const page = await browser.newPage();
  const requests = [];
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 120)));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === '/upload.html') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (url.pathname === '/api/v1/launch-flags') return flagsHandler(route);
    requests.push({ method: route.request().method(), path: url.pathname, body: route.request().postData() });
    if (url.pathname === '/billing/carrier-compatibility' && route.request().method() === 'POST') {
      return route.fulfill(afterLoad && afterLoad.recordResponse ? afterLoad.recordResponse : { status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`${ORIGIN}/upload.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500); // covers the fetch settling; the hang case never settles
  const label = await page.evaluate(() => (document.getElementById('carrierLandlineLabel') || {}).textContent);
  let extra = {};
  if (afterLoad && afterLoad.chooseLandline) {
    extra = await page.evaluate(async () => {
      // un-hide the ancestors of the carrier card so the real controls can be driven
      let el = document.getElementById('carrierDeviceLandline');
      for (let n = el; n; n = n.parentElement) n.hidden = false;
      el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true }));
      const btn = document.getElementById('checkCarrierButton') || document.querySelector('[id*="heckCarrier"]');
      if (btn) { btn.hidden = false; btn.click(); }
      await new Promise((r) => setTimeout(r, 600));
      const panel = document.getElementById('landlineComingSoonMessage');
      const consent = document.getElementById('termsConsentSection');
      return { panelVisible: !!panel && !panel.hidden, consentVisible: !!consent && !consent.hidden, labelAfter: document.getElementById('carrierLandlineLabel').textContent };
    });
    await page.waitForTimeout(400);
  }
  await page.close();
  return { name, label, requests, pageErrors, extra, ok: expectOpen === undefined ? true : (label === (expectOpen ? OPEN_LABEL : CLOSED_LABEL)) };
}

const json = (obj, status = 200) => (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
const browser = await chromium.launch({ channel: 'chrome' });
let bad = 0;
const results = [];
const scenarios = [
  ['flag says landlineComingSoon:true', json({ iosComingSoon: true, landlineComingSoon: true }), false],
  ['launch-flags request FAILS (network abort)', (r) => r.abort(), false],
  ['launch-flags returns 500 WITH body {landlineComingSoon:false}', json({ landlineComingSoon: false }, 500), false],
  ['launch-flags returns 404', json({}, 404), false],
  ['launch-flags returns 200 malformed (HTML)', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html>Bad Gateway</html>' }), false],
  ['launch-flags returns 200 but field MISSING (older server)', json({ iosComingSoon: true }), false],
  ['launch-flags returns landlineComingSoon:"false" (string)', json({ landlineComingSoon: 'false' }), false],
  ['launch-flags returns landlineComingSoon:0', json({ landlineComingSoon: 0 }), false],
  ['launch-flags returns landlineComingSoon:null', json({ landlineComingSoon: null }), false],
  ['launch-flags returns JSON null', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: 'null' }), false],
  ['launch-flags HANGS (never answers)', () => {}, false],
  ['launch-flags returns 200 landlineComingSoon:false  (the ONLY open case)', json({ landlineComingSoon: false }), true],
];
for (const [name, handler, expectOpen] of scenarios) {
  const r = await run(browser, name, handler, { expectOpen });
  results.push(r);
  if (!r.ok) bad++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${name}\n        label shown: "${r.label}"  (expected ${expectOpen ? 'OPEN' : 'Coming soon'})`);
}

// Recording the choice: a 400 (or any answer) must never open landline; provider "other" is sent.
for (const [name, recordResponse] of [
  ['choose Landline while Coming soon; server answers 400 invalid_input', { status: 400, contentType: 'application/json', body: '{"error":"invalid_input"}' }],
  ['choose Landline while Coming soon; server answers 200 with reason landline_coming_soon', { status: 200, contentType: 'application/json', body: '{"canProceedToPayment":false,"customerState":"landline_provider_unsupported","reason":"landline_coming_soon"}' }],
  ['choose Landline while Coming soon; server answers 500', { status: 500, contentType: 'application/json', body: '{}' }],
]) {
  const r = await run(browser, name, json({ iosComingSoon: true, landlineComingSoon: true }), { afterLoad: { chooseLandline: true, recordResponse } });
  const post = r.requests.find((q) => q.method === 'POST' && q.path === '/billing/carrier-compatibility');
  const sentOther = post && JSON.parse(post.body || '{}').provider === 'other' && JSON.parse(post.body).deviceType === 'landline';
  const ok = r.extra.labelAfter === CLOSED_LABEL && r.extra.panelVisible && !r.extra.consentVisible && sentOther;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        Coming-soon panel shown: ${r.extra.panelVisible} | consent/Stripe section shown: ${r.extra.consentVisible} | label after: "${r.extra.labelAfter}" | request body sent provider "other": ${!!sentOther}`);
}
await browser.close();
console.log(bad === 0 ? '\nAll browser checks passed.' : `\n${bad} browser check(s) FAILED.`);
process.exit(bad === 0 ? 0 : 1);
