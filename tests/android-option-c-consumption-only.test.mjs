// Android Option C: a consumption-only app (WS4, 2026-10-10).
//
// Google Play Payments policy: an Android app may not sell a subscription
// outside Play Billing, nor lead users to another payment method through
// "in-app webviews, buttons, links, messaging ... or other calls to action"
// or sign-up flows (section 4). A consumption-only app may give information
// about purchasing "without direct links" (Payments policy FAQ). See
// docs/launch/2026-10-09-ANDROID-COMPLIANT-PAYMENTS.md §3.
//
// This test FAILS if any Android-reachable purchase, checkout, Billing
// Portal, price or web-checkout link reappears in the app:
//   1. the platform rules and copy in mobile/lib/subscriptionPrice.ts
//      (executed directly);
//   2. a static scan of every screen and component (comments stripped);
//   3. the wiring of subscribe.tsx, membership.tsx and account/legal.tsx;
//   4. iOS keeps its StoreKit purchase, Apple settings and portal paths.
//
// Run with: node tests/android-option-c-consumption-only.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobile = path.join(root, 'mobile');
const read = (...p) => readFileSync(path.join(root, ...p), 'utf8');
// Strip block, JSX and line comments so documentation can explain history.
const code = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([;{},)])\s*\/\/.*$/gm, '$1');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

// ---- 1. platform rules + copy (executed) ----
const lib = await import(pathToFileURL(path.join(mobile, 'lib', 'subscriptionPrice.ts')).href);
const { canPurchaseInApp, showsMembershipPriceInApp, membershipManagement, CONSUMPTION_ONLY_COPY, SUPPORT_EMAIL_ADDRESS } = lib;

check(canPurchaseInApp('ios') === true, 'iOS keeps its in-app (StoreKit) purchase');
check(['android', 'web', 'windows', 'macos', '', undefined].every((p) => canPurchaseInApp(p) === false), 'Android (and every non-iOS platform) cannot purchase in the app');
check(showsMembershipPriceInApp('ios') === true && showsMembershipPriceInApp('android') === false, 'the Membership card shows a price on iOS only');

const sources = ['stripe', 'apple_revenuecat', 'admin_manual', 'google_revenuecat', null, undefined];
const statuses = ['active', 'payment_issue', 'cancelled', 'trialing', null];
let androidPortal = 0;
for (const billingSource of sources) for (const manageable of [true, false]) for (const status of statuses) {
  const m = membershipManagement({ platformOS: 'android', billingSource, manageable, status });
  if (m.kind === 'stripe_portal' || m.kind === 'apple_settings') androidPortal++;
}
check(androidPortal === 0, 'Android: no combination of billing source / manageable / status ever yields the Billing Portal or the iOS-only Apple settings link');
const aw = membershipManagement({ platformOS: 'android', billingSource: 'stripe', manageable: true, status: 'active' });
check(aw.kind === 'website_text' && aw.paymentIssue === false, 'Android, web-billed: plain-text "manage on our website" (with Email support)');
check(membershipManagement({ platformOS: 'android', billingSource: 'stripe', manageable: true, status: 'payment_issue' }).paymentIssue === true, 'Android, payment problem: the payment-issue text, still no portal');
check(membershipManagement({ platformOS: 'android', billingSource: 'apple_revenuecat', manageable: true, status: 'active' }).kind === 'apple_billed_text', 'Android, Apple-billed: plain text (the itms-apps link does not work on Android)');
check(membershipManagement({ platformOS: 'android', billingSource: 'admin_manual', manageable: false, status: 'active' }).kind === 'none', 'Android, complimentary: nothing to manage');
// iOS behaviour unchanged.
check(membershipManagement({ platformOS: 'ios', billingSource: 'apple_revenuecat', manageable: false, status: 'active' }).kind === 'apple_settings', 'iOS, Apple-billed: Apple subscription settings (unchanged)');
check(membershipManagement({ platformOS: 'ios', billingSource: 'stripe', manageable: true, status: 'active' }).kind === 'stripe_portal', 'iOS, web-billed + manageable: the existing Billing Portal (unchanged)');
check(membershipManagement({ platformOS: 'ios', billingSource: 'stripe', manageable: false, status: 'active' }).kind === 'none', 'iOS, not manageable: no button (unchanged)');

const copy = Object.values(CONSUMPTION_ONLY_COPY);
const joined = copy.join('\n');
check(Object.isFrozen(CONSUMPTION_ONLY_COPY), 'the consumption-only copy is frozen');
check(!/£|\$|€|\d+[.,]\d{2}|per month|\/month|a month|monthly price/i.test(joined), 'consumption-only copy contains no amount or price wording');
check(!/https?:|www\.|:\/\/|\.html|\/register|\/login|\/upload|\/dashboard|checkout|stripe|portal|qr/i.test(joined), 'consumption-only copy contains no URL, path, checkout, Stripe, portal or QR reference');
check(!/cheaper|discount|save money|better price|lower price|offer|deal|subscribe now|buy|sign up now|tap here|click/i.test(joined), 'no "cheaper on the web", offer or call-to-action wording');
check(CONSUMPTION_ONLY_COPY.websiteNote === 'Membership is set up on our website, homecallguard.co.uk.', 'the website note is exactly the approved plain-text sentence');
check((joined.match(/homecallguard\.co\.uk/g) || []).every(Boolean) && !/homecallguard\.co\.uk\//.test(joined), 'the website is only ever the bare domain name (no path)');
check(/cancel/i.test(CONSUMPTION_ONLY_COPY.manageOnWebsite) && CONSUMPTION_ONLY_COPY.manageOnWebsite.includes(SUPPORT_EMAIL_ADDRESS), 'a web-billed Android customer is told how to cancel (website account or email support)');
check(/call forwarding/i.test(CONSUMPTION_ONLY_COPY.forwardingReminder) && /cancel/i.test(CONSUMPTION_ONLY_COPY.forwardingReminder), 'the cancellation text reminds the customer that cancelling does not switch off call forwarding');
check(SUPPORT_EMAIL_ADDRESS === 'support@homecallguard.co.uk', 'support address is the published support mailbox');

// ---- 2. static scan of every screen and component ----
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p);
  }
  return out;
}
const appFiles = [...walk(path.join(mobile, 'app')), ...walk(path.join(mobile, 'components'))];
const libFiles = readdirSync(path.join(mobile, 'lib')).filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(mobile, 'lib', f));
const rel = (p) => path.relative(root, p);
const appCode = new Map(appFiles.map((f) => [f, code(readFileSync(f, 'utf8'))]));

check(appFiles.length > 20, `scanned ${appFiles.length} screens and components`);
const offenders = (re, files = appCode) => [...files].filter(([, c]) => re.test(c)).map(([f]) => rel(f));

let o = offenders(/\bcreateCheckoutSession\b|\bfetchStripeOffer\b|openAuthSessionAsync/);
check(o.length === 0, `no screen or component starts Stripe Checkout, fetches the Stripe offer or opens an auth-session browser (${o.join(', ') || 'none'})`);
o = offenders(/\bcreatePortalSession\b/).filter((f) => f !== 'mobile/app/(tabs)/membership.tsx');
check(o.length === 0, `the Billing Portal is referenced only by membership.tsx (iOS-gated, checked below) (${o.join(', ') || 'none'})`);
o = offenders(/create-checkout-session|manage-membership|billing\/offer|checkout\.stripe|buy\.stripe|billing\.stripe|stripe\.com|\/register\.html|\/upload\b|\/dashboard\b|\/login\.html|["'`]\/terms\.html|["'`]\/privacy\.html/);
// account/legal.tsx and subscribe.tsx keep /terms.html and /privacy.html for iOS ONLY (checked below).
o = o.filter((f) => !['mobile/app/(tabs)/account/legal.tsx', 'mobile/app/(setup)/subscribe.tsx'].includes(f) || offenders(/create-checkout-session|manage-membership|billing\/offer|stripe\.com|checkout\.stripe|\/register|\/upload|\/dashboard|\/login/, new Map([[path.join(root, f), appCode.get(path.join(root, f))]])).length > 0);
check(o.length === 0, `no screen or component contains a checkout/portal endpoint, Stripe URL or website sign-up/login/dashboard path (${o.join(', ') || 'none'})`);
o = offenders(/https?:\/\//);
check(o.length === 0, `no screen or component hard-codes a web URL (${o.join(', ') || 'none'})`);
o = offenders(/£\s?\d|\d+\.\d{2}\s*(\/|per)\s*month/i);
check(o.length === 0, `no screen or component hard-codes a price (${o.join(', ') || 'none'})`);
o = offenders(/qrcode|QRCode|react-native-qrcode/);
check(o.length === 0, 'no QR code component anywhere in the app');
o = offenders(/cheaper|better price|save money/i);
check(o.length === 0, `no "cheaper on the web" wording (${o.join(', ') || 'none'})`);
const pkg = JSON.parse(read('mobile', 'package.json'));
check(!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((d) => /qr/i.test(d)), 'no QR-code dependency in mobile/package.json');

// Every in-app browser open is a navigation-free legal page (or the iOS-only portal).
const browserOpens = [];
for (const [f, c] of appCode) for (const m of c.matchAll(/WebBrowser\.open\w*\(([^)]*)\)/g)) browserOpens.push({ file: rel(f), arg: m[1].trim() });
const allowedOpen = (b) => ['`${API_BASE_URL}${TERMS_PATH}`', '`${API_BASE_URL}${PRIVACY_PATH}`'].includes(b.arg) || (b.file === 'mobile/app/(tabs)/membership.tsx' && b.arg === 'url');
check(browserOpens.length > 0 && browserOpens.every(allowedOpen), `every in-app browser open is a legal page path constant (or membership's iOS-only portal url): ${browserOpens.map((b) => `${b.file}:${b.arg}`).join(' | ')}`);
for (const f of ['mobile/app/(setup)/subscribe.tsx', 'mobile/app/(tabs)/account/legal.tsx']) {
  const c = appCode.get(path.join(root, f));
  check(c.includes('const TERMS_PATH = Platform.OS === "ios" ? "/terms.html" : "/legal/terms-app.html";') && c.includes('const PRIVACY_PATH = Platform.OS === "ios" ? "/privacy.html" : "/legal/privacy-app.html";'),
    `${f}: Android opens /legal/terms-app.html and /legal/privacy-app.html (no site navigation); iOS keeps /terms.html and /privacy.html`);
}
const usesLegalPaths = [...appCode].filter(([, c]) => /TERMS_PATH|PRIVACY_PATH/.test(c)).map(([f]) => rel(f)).sort();
check(JSON.stringify(usesLegalPaths) === JSON.stringify(['mobile/app/(setup)/subscribe.tsx', 'mobile/app/(tabs)/account/legal.tsx']), 'only subscribe.tsx and account/legal.tsx open legal pages');

// Linking.openURL: only mailto/tel/settings-style targets, never the web.
const opens = [];
for (const [f, c] of appCode) for (const m of c.matchAll(/Linking\.openURL\(([^)]*)\)/g)) opens.push({ file: rel(f), arg: m[1].trim() });
const okOpen = (x) => /^["'`]mailto:/.test(x.arg) || x.arg === 'mailto' || x.arg === 'url' || (x.file === 'mobile/app/(tabs)/membership.tsx' && ['APPLE_MANAGE_SUBSCRIPTIONS_URL', '`mailto:${SUPPORT_EMAIL_ADDRESS}?subject=${encodeURIComponent(subject)}`'].includes(x.arg));
check(opens.every(okOpen), `Linking.openURL targets are mailto:, dial links (\`url\` from the dial helpers) or membership's iOS-only Apple settings: ${opens.map((x) => `${x.file}:${x.arg}`).join(' | ')}`);
for (const f of ['mobile/app/(setup)/activate.tsx', 'mobile/app/(tabs)/account/set-up-call-forwarding.tsx']) {
  const c = appCode.get(path.join(root, f));
  if (c && /Linking\.openURL\(url\)/.test(c)) check(/tel:|dialerLink|buildDial|telUri|toTelUrl/i.test(c) || /from "\.\.\/\.\.\/lib\/dialerLink"|from "\.\.\/\.\.\/\.\.\/lib\/dialerLink"/.test(c), `${f}: its openURL(url) is a dial link (lib/dialerLink), not a web page`);
}
const dialer = code(read('mobile', 'lib', 'dialerLink.ts'));
check(!/https?:/.test(dialer), 'lib/dialerLink.ts builds no web URL');

// No lib file other than api.ts names a checkout/portal endpoint, and api.ts's
// checkout/portal helpers are not imported by anything Android-reachable.
o = libFiles.filter((f) => path.basename(f) !== 'api.ts' && /create-checkout-session|manage-membership|billing\/offer/.test(code(readFileSync(f, 'utf8')))).map(rel);
check(o.length === 0, `only lib/api.ts defines the (now unused in-app) checkout/portal/offer calls (${o.join(', ') || 'none'})`);
o = libFiles.filter((f) => path.basename(f) !== 'api.ts' && /\bcreateCheckoutSession\b|\bcreatePortalSession\b|\bfetchStripeOffer\b/.test(code(readFileSync(f, 'utf8')))).map(rel);
check(o.length === 0, `no other lib module calls the checkout/portal/offer helpers (${o.join(', ') || 'none'})`);

// ---- 3. screen wiring ----
const sub = appCode.get(path.join(mobile, 'app', '(setup)', 'subscribe.tsx'));
check(sub.includes('const IN_APP_PURCHASE = canPurchaseInApp(Platform.OS);'), 'Subscribe: the purchase gate comes from canPurchaseInApp(Platform.OS)');
check(/async function handleSubscribe\(\) \{\s*setError\(null\);\s*if \(!IN_APP_PURCHASE\) return;/.test(sub), 'Subscribe: handleSubscribe returns before anything else off iOS (no terms record, no carrier call, no purchase)');
check(/useEffect\(\(\) => \{\s*if \(!IN_APP_PURCHASE\) return;/.test(sub), 'Subscribe: the price is never fetched off iOS');
check(!/handleSubscribeStripe|WebBrowser\.openAuthSessionAsync|RETURN_URL/.test(sub), 'Subscribe: the Stripe Checkout path is gone');
const optCStart = sub.search(/if \(!IN_APP_PURCHASE\) \{\s*return \(/);
const optC = optCStart === -1 ? '' : sub.slice(optCStart, sub.indexOf('\n  return (\n', optCStart));
check(optC.length > 100, 'Subscribe: a consumption-only view exists and returns before the purchase view');
check(optCStart !== -1 && optCStart < sub.indexOf('label={subscribeButtonLabel(displayPrice)}'), 'Subscribe: the consumption-only view returns before the pay button');
check(!/subscribePriceLine|subscribeButtonLabel|displayPrice|PRICE_PENDING_NOTE|handleSubscribe\b|Subscribe & pay/.test(optC), 'Subscribe (Android view): no price, price note or pay button');
check(optC.includes('CONSUMPTION_ONLY_COPY.websiteNote') && /<Text style=\{styles\.body\} selectable=\{false\}>\{CONSUMPTION_ONLY_COPY\.websiteNote\}<\/Text>/.test(optC), 'Subscribe (Android view): the website is plain, non-selectable text');
check(optC.includes('onPress={handleCheckMembershipAgain}') && (optC.match(/<PrimaryButton/g) || []).length === 1, 'Subscribe (Android view): the only button re-checks membership');
check(/async function handleCheckMembershipAgain\(\)[\s\S]{0,400}await fetchDashboard\(session\?\.access_token\);[\s\S]{0,120}router\.replace\("\/\(setup\)\/welcome"\);/.test(sub), 'Subscribe (Android view): an entitled account (paid on the website) continues through setup welcome, exactly like any entitled account');
check(/await acceptTerms\(session\?\.access_token\);\s*await handleSubscribeIOS\(\);/.test(sub), 'Subscribe (iOS): terms are recorded, then the StoreKit purchase starts (unchanged)');

const mem = appCode.get(path.join(mobile, 'app', '(tabs)', 'membership.tsx'));
check(/async function handleManage\(\) \{\s*if \(Platform\.OS !== "ios"\) return;/.test(mem), 'Membership: handleManage (Billing Portal) returns immediately off iOS');
check((mem.match(/onPress=\{handleManage\}/g) || []).length === 1 && /management\.kind === "stripe_portal" && \(\s*<PrimaryButton[\s\S]{0,200}onPress=\{handleManage\}/.test(mem), 'Membership: the portal button renders only for management.kind === "stripe_portal" (iOS only)');
check(mem.includes('membershipManagement({') && mem.includes('platformOS: Platform.OS,'), 'Membership: the management kind comes from membershipManagement(Platform.OS, …)');
check(/showsMembershipPriceInApp\(Platform\.OS\) \? membership\.priceLabel : CONSUMPTION_ONLY_COPY\.billedOnWebsite/.test(mem) && (mem.match(/membership\.priceLabel/g) || []).length === 1, 'Membership: the price label is shown on iOS only');
check(/management\.kind === "website_text"[\s\S]{0,300}CONSUMPTION_ONLY_COPY\.manageOnWebsite[\s\S]{0,200}CONSUMPTION_ONLY_COPY\.forwardingReminder/.test(mem), 'Membership (Android, web-billed): how to change or cancel, plus the forwarding reminder');
check(/onPress=\{handleEmailSupport\}/.test(mem) && /mailto:\$\{SUPPORT_EMAIL_ADDRESS\}/.test(mem), 'Membership (Android): an "Email support" mailto button, so cancellation is always possible from the app');
check(/onPress=\{handleManageIOS\}/.test(mem) && /management\.kind === "apple_settings" && <PrimaryButton label="Manage subscription" onPress=\{handleManageIOS\} \/>/.test(mem), 'Membership (iOS, Apple-billed): Apple settings button unchanged');
check(/const restoreButton = Platform\.OS === "ios" &&/.test(mem), 'Membership: Restore purchases stays iOS-only');

const purchases = code(read('mobile', 'lib', 'purchases.ts'));
check(/export async function fetchHcgPackage\(\)[^{]*\{\s*if \(Platform\.OS !== "ios" \|\| !REVENUECAT_API_KEY_IOS\) throw new PurchasesNotConfiguredError\(\);/.test(purchases)
  && /export async function purchaseHcgPackage\([^)]*\)[^{]*\{\s*if \(Platform\.OS !== "ios"\) throw new PurchasesNotConfiguredError\(\);/.test(purchases)
  && /export async function restorePurchases\(\)[^{]*\{\s*if \(Platform\.OS !== "ios"\) throw new PurchasesNotConfiguredError\(\);/.test(purchases),
'lib/purchases.ts: no store purchase, offering fetch or restore can run off iOS');

console.log(failures === 0 ? '\nAndroid Option C (consumption-only): all checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
