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
  source.includes('/terms.html') && source.includes('Terms of Use'),
  'subscribe.tsx links to Terms of Use (/terms.html)'
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

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
