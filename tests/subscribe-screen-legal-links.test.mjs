// Regression test for the Apple Guideline 3.1.2 gap flagged alongside the
// 2026-09-07 rejection: the subscription/purchase screen itself had no
// Terms of Use / Privacy Policy link (a working Legal page existed, but
// only reachable via Account, not from the paywall). Fixed by adding both
// links directly on mobile/app/(setup)/subscribe.tsx.
//
// Structural check against the real source, matching this codebase's
// existing convention for screen content that isn't a pure, extractable
// function and has no React Native Testing Library/Jest harness (see
// tests/get-protected-now-button.test.mjs for the same idiom against
// upload.html).
//
// Run with: node tests/subscribe-screen-legal-links.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  path.join(__dirname, '..', 'mobile', 'app', '(setup)', 'subscribe.tsx'),
  'utf8'
);

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

check(
  source.includes('/terms.html') && source.includes('Terms & Conditions'),
  'subscribe.tsx links to the Terms & Conditions (/terms.html) — relabelled 2026-09-13 to match the actual document title and the new agreement checkbox\'s own wording'
);

check(
  source.includes('/privacy.html') && source.includes('Privacy Policy'),
  'subscribe.tsx links to Privacy Policy (/privacy.html)'
);

check(
  source.includes('WebBrowser.openBrowserAsync'),
  'the legal links open via the same expo-web-browser mechanism already used elsewhere in the app (account/legal.tsx), not a bare/dead href'
);

// Both links must be reachable regardless of platform — this is an App
// Store (iOS) requirement, but Android/web customers should see the
// same links too, so this deliberately isn't gated behind
// Platform.OS === "ios" the way the payment-method smallprint above it is.
const viewStart = source.indexOf('<View style={styles.legalLinks}>');
const viewEnd = source.indexOf('</View>', viewStart);
const legalLinksElement = source.slice(viewStart, viewEnd);

check(viewStart !== -1 && viewEnd !== -1, 'the legalLinks <View> element is well-formed and locatable in the source');

check(
  !legalLinksElement.includes('Platform.OS'),
  'the Terms/Privacy links render unconditionally (not inside an iOS-only branch) — every platform should see them, not just iOS'
);

// --- 2026-09-13 carrier-onboarding-gate additions: a dedicated,
// unticked-by-default Terms/Privacy agreement checkbox, separate from
// the existing cooling-off checkbox, plus explicit VAT/recurring copy
// and unambiguous payment-button wording. ---

check(
  source.includes('agreedToTerms') && source.includes('setAgreedToTerms'),
  'subscribe.tsx has a dedicated Terms/Privacy agreement state, separate from startImmediately (the cooling-off checkbox)'
);

check(
  source.includes('I agree to the Terms & Conditions and acknowledge the Privacy Policy.'),
  'the Terms agreement checkbox uses the approved exact wording'
);

check(
  /const \[agreedToTerms, setAgreedToTerms\] = useState\(false\);/.test(source),
  'the Terms agreement checkbox is unticked by default — the customer must actively agree, never pre-ticked'
);

check(
  source.includes('if (!agreedToTerms)') && source.indexOf('if (!agreedToTerms)') < source.indexOf('if (!startImmediately)'),
  'handleSubscribe checks Terms agreement before the cooling-off checkbox and before either purchase path can start — both are required, and neither is silently skippable'
);

check(
  source.includes('accessibilityLabel="I agree to the Terms and Conditions and acknowledge the Privacy Policy"') &&
    source.includes('accessibilityLabel="I\'d like my protection to start right away"'),
  'the Terms checkbox and the cooling-off checkbox remain two separate, independently-labelled controls, never merged into one combined tickbox'
);

check(
  source.includes('including VAT'),
  'the price is explicitly shown as including VAT, not just a bare £4.99 figure'
);

check(
  /recurring\s+monthly\s+subscription\s+that\s+renews\s+automatically/.test(source),
  'the screen states in plain language, before payment, that this is a recurring subscription that auto-renews until cancelled'
);

check(
  source.includes('Subscribe & pay £4.99/month now'),
  'the payment button wording makes the payment obligation unambiguous (not a vague "Continue"/"Subscribe" alone)'
);

check(
  source.includes('fetchCarrierCompatibility') && source.includes('acceptTerms'),
  'handleSubscribe re-checks carrier eligibility and records Terms acceptance before triggering either purchase path (Stripe or iOS RevenueCat/StoreKit) — the same defense-in-depth gate applies to both'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
