// Structural tests for the email-confirmation session-handoff fallback
// (2026-09-20) — the launch-critical defect where a real customer's
// email confirmation succeeded but the browser never received/
// established an authenticated session, leaving them stuck on
// confirmed.html with a plain, contextless "Log In" link.
//
// The fix: confirmed.html now actively redirects every failure path to
// /login.html?state=confirmed&email=..., pre-filling the email wherever
// it can be recovered (the access_token JWT's own `email` claim, or a
// same-browser sessionStorage value set by register.html at submit
// time) and login.html shows "Your email is confirmed. Enter your
// password to continue." — the customer only ever has to type their
// password again. The ideal path (session establishes automatically) is
// unchanged: straight into /dashboard, no login screen at all.
//
// No HTTP/browser test tooling exists in this project — every file is
// checked directly against its real source, matching the established
// convention (see tests/registration-flow.test.mjs, which reads
// public/register.html and public/login.html the same way, and
// tests/home-screen-error-handling.test.mjs for the equivalent mobile
// convention).
//
// Run with: node tests/email-confirmation-session-handoff.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, '..', 'public');

const confirmedSource = readFileSync(path.join(publicRoot, 'confirmed.html'), 'utf8');
const loginSource = readFileSync(path.join(publicRoot, 'login.html'), 'utf8');
const registerSource = readFileSync(path.join(publicRoot, 'register.html'), 'utf8');

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
// Ideal path — automatic session establishment still works exactly as
// before: straight into /dashboard, no login screen at all.
// ============================================================

check(
  /\.then\(function \(res\) \{[\s\S]*?window\.location\.href = "\/dashboard";[\s\S]*?\}\)/.test(confirmedSource),
  'a successful /confirm-session POST still navigates straight to /dashboard (the ideal path is unchanged)'
);
check(
  confirmedSource.includes('clearPendingEmail();\n        window.location.href = "/dashboard";'),
  'the success path clears the pending-email convenience value (no longer needed once the real session is established)'
);

// ============================================================
// Fallback path — every way session establishment can fail now
// redirects to the login screen with the email pre-filled, instead of
// leaving the customer on a dead-end page.
// ============================================================

check(
  confirmedSource.includes('function goToLoginFallback(prefillEmail) {') &&
    confirmedSource.includes('var url = "/login.html?state=confirmed";') &&
    confirmedSource.includes('url += "&email=" + encodeURIComponent(prefillEmail);') &&
    confirmedSource.includes('window.location.replace(url);'),
  'goToLoginFallback() redirects to /login.html?state=confirmed with the email pre-filled when available'
);

check(
  /if \(!accessToken \|\| !refreshToken\) \{[\s\S]*?goToLoginFallback\(readPendingEmail\(\)\);[\s\S]*?return;[\s\S]*?\}/.test(confirmedSource),
  'no usable tokens at all in the confirmation redirect (link already consumed) falls back to the login screen, not a dead end'
);
check(
  confirmedSource.includes('.catch(function () {\n        goToLoginFallback(decodeEmailFromToken(accessToken) || readPendingEmail());\n      });'),
  'a failed /confirm-session POST also falls back to the login screen, preferring the email decoded from the real access_token JWT over the same-browser convenience value'
);

check(
  confirmedSource.includes('function decodeEmailFromToken(token) {') &&
    confirmedSource.includes('claims.email'),
  'decodeEmailFromToken reads the email claim directly out of the (unverified, display-only) access_token JWT payload'
);
check(
  !/verify|jwt\.verify|jsonwebtoken/i.test(confirmedSource.slice(confirmedSource.indexOf('function decodeEmailFromToken'), confirmedSource.indexOf('function goToLoginFallback'))),
  'the JWT is never cryptographically verified client-side — it is used purely to pre-fill a display field, not to authenticate'
);

check(
  confirmedSource.includes('function readPendingEmail() {') &&
    confirmedSource.includes('sessionStorage.getItem(PENDING_EMAIL_KEY)') &&
    confirmedSource.includes('function clearPendingEmail() {') &&
    confirmedSource.includes('sessionStorage.removeItem(PENDING_EMAIL_KEY)'),
  'the same-browser pending-email convenience value is read from and cleared out of sessionStorage, never localStorage or a cookie'
);

check(
  !/localStorage/.test(confirmedSource) &&
    !/document\.cookie\s*=/.test(confirmedSource) &&
    !confirmedSource.includes('"password"') &&
    !confirmedSource.includes("'password'"),
  'confirmed.html never reads/writes a password field, never touches localStorage, and never sets a cookie directly itself (session cookies remain server-set via /confirm-session)'
);

// ============================================================
// register.html — stashes the pending email at submit time, matching
// key, holds only an email address.
// ============================================================

check(
  registerSource.includes('sessionStorage.setItem("hcg_pending_confirmation_email", document.getElementById("email").value);'),
  'register.html stashes the entered email into sessionStorage synchronously at submit time (not read back after the server redirect, which does not reliably preserve it)'
);
check(
  confirmedSource.includes('var PENDING_EMAIL_KEY = "hcg_pending_confirmation_email";'),
  'confirmed.html reads back the exact same sessionStorage key register.html writes — no silent key-name drift between the two files'
);
check(
  /try \{\s*sessionStorage\.setItem\("hcg_pending_confirmation_email", document\.getElementById\("email"\)\.value\);\s*\} catch/.test(registerSource),
  'the sessionStorage write is wrapped in try/catch — private browsing or disabled storage must never break account creation itself'
);

// ============================================================
// login.html — the state=confirmed branch: exact message, email
// pre-fill, password field focused so the customer can start typing
// immediately.
// ============================================================

check(
  loginSource.includes('} else if (state === "confirmed") {'),
  'login.html handles ?state=confirmed as its own distinct branch, separate from the error and other notice states'
);
check(
  loginSource.includes('confirmedNotice.textContent = "Your email is confirmed. Enter your password to continue.";'),
  'the state=confirmed banner shows the exact required message'
);
check(
  /state === "confirmed"[\s\S]*?if \(loginEmail\) \{\s*document\.getElementById\("email"\)\.value = loginEmail;\s*document\.getElementById\("password"\)\.focus\(\);\s*\}/.test(loginSource),
  'when an email was recovered, it pre-fills the email field and focuses the password field — the customer only has to type their password'
);

// ============================================================
// Post-fallback-login continuation — /login's existing redirect target
// logic (services/postLoginRouting.js's decidePostLoginRedirect) is
// untouched, so a successful password login from the state=confirmed
// screen lands exactly where any other login does: /dashboard (or
// /admin/business for an admin), which itself already resumes the
// correct onboarding/protection-status view. No special "resume"
// codepath was introduced or needed — this just proves the existing
// one was not disturbed by this fix.
// ============================================================

const serverSource = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check(
  serverSource.includes('const redirectTarget = decidePostLoginRedirect({ role });') &&
    serverSource.includes('return res.redirect(redirectTarget);'),
  '/login\'s post-authentication redirect logic is unchanged — a fallback login from the state=confirmed screen resumes onboarding via the same route as any other login'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
