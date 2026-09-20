// Structural tests for public/go.html — the TikTok/Instagram/Facebook
// "link in bio" landing page (2026-09-20 redesign). No HTTP/browser test
// tooling exists in this project — checked directly against the real
// source, matching the established convention (see
// tests/registration-flow.test.mjs, tests/home-screen-error-handling.test.mjs).
//
// Covers: a single obvious "Get Home Call Guard" primary CTA now exists;
// the required secondary routes (How It Works / Visit Home Call Guard)
// are present; every existing device-handling destination is preserved
// exactly (Android -> Google Play, Landline -> /dashboard, iPhone ->
// the same inline waiting-list mechanism, never a payment/Stripe route);
// no emoji remain; and server.js still serves this file at GET /go.
//
// Run with: node tests/go-landing-page.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const goSource = readFileSync(path.join(__dirname, '..', 'public', 'go.html'), 'utf8');
const serverSource = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// ============================================================
// Server wiring — unchanged
// ============================================================

check(
  serverSource.includes('app.get("/go", (req, res) => {') &&
    serverSource.includes('res.sendFile(__dirname + "/public/go.html");'),
  'server.js still serves public/go.html at GET /go'
);

// ============================================================
// Branding — HCG black/green identity, clearly identified
// ============================================================

check(
  goSource.includes('<img src="/logo.png" alt="Home Call Guard" class="logo">') &&
    goSource.includes('Home Call <span>Guard</span>'),
  'the page uses the real HCG logo and clearly identifies Home Call Guard by name, not a generic placeholder'
);
check(
  goSource.includes('--background: #07111f') && goSource.includes('--green: #22e59a'),
  'the page uses the existing HCG dark/green palette, not a new invented one'
);

// ============================================================
// Primary CTA — single, obvious "Get Home Call Guard" action
// ============================================================

check(
  /<a class="cta-primary"[^>]*>Get Home Call Guard<\/a>/.test(goSource),
  'a single, dominant "Get Home Call Guard" primary CTA exists, with the exact required wording'
);
check(
  (goSource.match(/class="cta-primary"/g) || []).length === 1,
  'there is exactly one primary CTA on the page — one obvious action, not several competing ones'
);

// ============================================================
// Secondary routes
// ============================================================

check(
  /<a href="\/#how-it-works"[^>]*>How Home Call Guard Works<\/a>/.test(goSource),
  '"How Home Call Guard Works" links to the real explainer section on the homepage (public/index.html\'s #how-it-works), not a dead/invented URL'
);
check(
  /<a href="\/"[^>]*>Visit Home Call Guard<\/a>/.test(goSource),
  '"Visit Home Call Guard" links to the real marketing homepage'
);

// ============================================================
// Device handling — every existing destination preserved exactly,
// never a new payment/Stripe bypass.
// ============================================================

check(
  goSource.includes('href="https://play.google.com/store/apps/details?id=co.uk.homecallguard.app"'),
  'Android still links to the real Google Play listing — unchanged destination'
);
check(
  goSource.includes('id="landlineOption" href="/dashboard"'),
  'Landline still links to the real /dashboard onboarding entry point (the existing eligibility/onboarding flow) — unchanged destination'
);
check(
  goSource.includes("fetch('/api/v1/waiting-list'") &&
    goSource.includes("reason: 'ios_coming_soon'"),
  'iPhone still uses the same public waiting-list endpoint/reason as before — no new backend surface introduced'
);
check(
  !/stripe|checkout\.stripe|create-checkout-session/i.test(goSource),
  'no Stripe/checkout reference anywhere on this page — every path goes through the existing app/website flows, never a direct payment route'
);

// ============================================================
// No emoji / approximations — real icon assets used instead
// ============================================================

check(
  !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(goSource),
  'no emoji characters anywhere on the page (the old 📱/☎️/🍎 device icons are gone)'
);
check(
  goSource.includes('src="/android-device-mark.png"') &&
    goSource.includes('src="/landline-device-mark.png"') &&
    goSource.includes('src="/iphone-device-mark.png"'),
  'each device option uses a real icon asset image, not an emoji or generic placeholder'
);

// ============================================================
// Existing behaviour preserved: analytics hooks, UTM forwarding, the
// iPhone inline-waitlist interaction, sign-in link, legal footer.
// ============================================================

check(
  goSource.includes("window.dispatchEvent(new CustomEvent('hcg:bio'"),
  'the analytics CustomEvent hook is preserved unchanged'
);
check(
  goSource.includes("['landlineOption', 'signinLink'].forEach"),
  'UTM query-string forwarding onto the Landline/Sign-in links is preserved unchanged'
);
check(
  goSource.includes("aria-controls=\"iosWaitPanel\"") && goSource.includes('panel.hidden = expanded;'),
  'the iPhone option still reveals the inline waiting-list panel rather than navigating anywhere'
);
check(
  goSource.includes('Already a customer?') && goSource.includes('href="/login.html"'),
  'the existing-customer sign-in link is preserved'
);
check(
  goSource.includes('href="/privacy"') && goSource.includes('href="/terms.html"'),
  'the Privacy/Terms footer links are preserved'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
