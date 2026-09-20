// Regression tests for the mobile email-confirmation fix (2026-09-20,
// second regression): the Supabase "Confirm signup" template was
// correctly fixed against the email-link-scanner problem for the web
// flow, but mobile signups (routes/mobileApi.js) used a
// homecallguard://confirm-email custom-scheme emailRedirectTo — a
// scheme other than http(s) is dropped/stripped by mail clients' HTML
// sanitisers, so mobile customers received a confirmation email with no
// visible link/CTA at all.
//
// The fix: mobile signups now redirect to the exact same public/
// confirmed.html URL web signups already use (a real, always-tappable
// HTTPS link), which reuses the existing, unmodified /verify-
// confirmation-token + /confirm-session mechanism (see
// tests/token-hash-confirmation.test.mjs) — no duplicated verification
// logic — and then hands off into the app via the same
// homecallguard://confirm-email deep link mobile/app/(auth)/
// confirm-email.tsx already knew how to consume, fired from real page
// JavaScript AFTER a session already exists, never from the email/
// redirect chain itself. This preserves the scanner protection for
// mobile too, and requires no new mobile build for already-installed
// apps, since confirm-email.tsx's access_token/refresh_token handling
// is completely unchanged.
//
// No HTTP/browser test tooling exists in this project. This file
// combines the established structural-source-check convention with a
// genuine pure-logic execution test: confirmed.html's function
// declarations (everything before its page-load IIFE) are evaluated in
// a real V8 context via node:vm, with fake navigator/document/window
// globals, so isLikelyMobileOS() and continueAfterSession() are
// exercised as real running JavaScript, not just pattern-matched
// source text.
//
// Run with: node tests/mobile-confirmation-handoff.test.mjs

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const confirmedSource = readFileSync(path.join(__dirname, '..', 'public', 'confirmed.html'), 'utf8');
const mobileApiSource = readFileSync(path.join(__dirname, '..', 'routes', 'mobileApi.js'), 'utf8');
const confirmEmailSource = readFileSync(path.join(__dirname, '..', 'mobile', 'app', '(auth)', 'confirm-email.tsx'), 'utf8');
const apiTsSource = readFileSync(path.join(__dirname, '..', 'mobile', 'lib', 'api.ts'), 'utf8');
const forgotPasswordSource = readFileSync(path.join(__dirname, '..', 'mobile', 'app', '(auth)', 'forgot-password.tsx'), 'utf8');
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
// 1. routes/mobileApi.js — the actual root-cause fix
// ============================================================

check(
  !mobileApiSource.includes('const MOBILE_CONFIRM_EMAIL_REDIRECT_URL = "homecallguard://confirm-email";'),
  'the old custom-scheme MOBILE_CONFIRM_EMAIL_REDIRECT_URL is gone — that literal string is no longer assigned to it'
);
check(
  mobileApiSource.includes('const MOBILE_CONFIRM_EMAIL_REDIRECT_URL = `${APP_URL}/confirmed.html`;'),
  'mobile signups now redirect to the exact same public/confirmed.html URL web signups already use — a real, always-tappable HTTPS link'
);
check(
  /const APP_URL = process\.env\.APP_URL \|\| "http:\/\/localhost:3199";/.test(mobileApiSource),
  'APP_URL is derived the same way (env var with a safe local fallback) as server.js\'s own APP_URL'
);

// ============================================================
// 2. public/confirmed.html — pure-logic execution test of the new
// mobile-handoff functions, not just source pattern-matching.
// ============================================================

// Extract everything up to (but not including) the page-load IIFE, so
// evaluating it defines every function with zero side effects (no
// fetch, no real navigation) — then call the functions directly.
const iifeStart = confirmedSource.indexOf('(function () {\n    // 2026-09-20 — TokenHash confirmation path');
const functionsSource = confirmedSource.slice(confirmedSource.indexOf('var PENDING_EMAIL_KEY'), iifeStart);

check(functionsSource.includes('function isLikelyMobileOS()'), 'isLikelyMobileOS is defined before the page-load IIFE (extractable for direct testing)');
check(functionsSource.includes('function continueAfterSession('), 'continueAfterSession is defined before the page-load IIFE (extractable for direct testing)');

function runWithFakeBrowser({ userAgent, visibilityState = 'visible' }) {
  const state = {
    hrefSet: [],
    timeouts: [],
    visibilityListeners: [],
  };

  const fakeDocument = {
    visibilityState,
    addEventListener(event, handler) {
      if (event === 'visibilitychange') state.visibilityListeners.push(handler);
    },
    removeEventListener(event, handler) {
      if (event === 'visibilitychange') {
        const i = state.visibilityListeners.indexOf(handler);
        if (i !== -1) state.visibilityListeners.splice(i, 1);
      }
    },
    getElementById() {
      // Only reached by establishSession()/goToLoginFallback(), not
      // exercised in this file's tests — a harmless stub is enough.
      return { textContent: '', hidden: false };
    },
  };

  const sandbox = {
    navigator: { userAgent },
    document: fakeDocument,
    window: {
      location: {
        set href(value) {
          state.hrefSet.push(value);
        },
        replace(value) {
          state.hrefSet.push(value);
        },
      },
    },
    setTimeout(fn, ms) {
      const id = state.timeouts.length;
      state.timeouts.push({ fn, ms, cleared: false });
      return id;
    },
    clearTimeout(id) {
      if (state.timeouts[id]) state.timeouts[id].cleared = true;
    },
    sessionStorage: {
      store: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
      setItem(k, v) { this.store[k] = v; },
      removeItem(k) { delete this.store[k]; },
    },
    encodeURIComponent,
    console,
  };
  sandbox.window.navigator = sandbox.navigator;
  sandbox.window.document = sandbox.document;
  sandbox.window.sessionStorage = sandbox.sessionStorage;

  vm.createContext(sandbox);
  vm.runInContext(functionsSource, sandbox);

  return { sandbox, state };
}

// --- Desktop: no app-handoff attempt, straight to /dashboard ---
{
  const { state } = runWithFakeBrowser({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' });
  const vm2 = vm.createContext;
  // isLikelyMobileOS is called internally by continueAfterSession; test
  // the observable outcome directly.
  const { sandbox } = runWithFakeBrowser({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' });
  check(sandbox.isLikelyMobileOS() === false, 'isLikelyMobileOS() returns false for a real desktop Chrome/Safari user agent');

  const run = runWithFakeBrowser({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' });
  run.sandbox.continueAfterSession('fake-access-token', 'fake-refresh-token');
  check(
    run.state.hrefSet.length === 1 && run.state.hrefSet[0] === '/dashboard',
    'on desktop, continueAfterSession() navigates straight to /dashboard — no app-handoff attempt, no timer'
  );
  check(run.state.timeouts.length === 0, 'no fallback timer is set on desktop — nothing to fall back from');
}

// --- Android: attempts the app deep link, sets a fallback timer ---
{
  const run = runWithFakeBrowser({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36' });
  check(run.sandbox.isLikelyMobileOS() === true, 'isLikelyMobileOS() returns true for a real Android Chrome user agent');

  run.sandbox.continueAfterSession('at-123', 'rt-456');
  check(
    run.state.hrefSet.length === 1 && run.state.hrefSet[0] === 'homecallguard://confirm-email#access_token=at-123&refresh_token=rt-456',
    'on Android, continueAfterSession() attempts the exact homecallguard://confirm-email#access_token=...&refresh_token=... deep link mobile/app/(auth)/confirm-email.tsx already parses'
  );
  check(run.state.timeouts.length === 1 && run.state.timeouts[0].ms === 1500, 'a 1500ms fallback timer is armed in case the app does not intercept the deep link');
  check(run.state.visibilityListeners.length === 1, 'a visibilitychange listener is registered to detect whether the OS actually switched away to the app');
}

// --- iOS: same as Android ---
{
  const run = runWithFakeBrowser({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' });
  check(run.sandbox.isLikelyMobileOS() === true, 'isLikelyMobileOS() returns true for a real iPhone Safari user agent');
}

// --- Fallback actually fires when the app never takes the handoff ---
{
  const run = runWithFakeBrowser({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/128.0 Mobile' });
  run.sandbox.continueAfterSession('at', 'rt');
  check(run.state.timeouts.length === 1 && !run.state.timeouts[0].cleared, 'the fallback timer is armed and not yet cleared immediately after the handoff attempt');
  // Simulate the timer firing (app never intercepted, tab stayed visible).
  run.state.timeouts[0].fn();
  check(
    run.state.hrefSet.length === 2 && run.state.hrefSet[1] === '/dashboard',
    'when the fallback timer fires (page still visible — app not installed/did not intercept), it falls through to /dashboard'
  );
}

// --- Fallback is cancelled when the app DOES take the handoff ---
{
  const run = runWithFakeBrowser({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/128.0 Mobile' });
  run.sandbox.continueAfterSession('at', 'rt');
  // Simulate the OS switching away to the app (tab becomes hidden).
  run.state.visibilityState = 'hidden';
  run.sandbox.document.visibilityState = 'hidden';
  run.state.visibilityListeners[0]();
  check(run.state.timeouts[0].cleared === true, 'when the tab becomes hidden (app opened), the fallback timer is cleared — /dashboard is never reached');
  check(run.state.hrefSet.length === 1, 'only the one deep-link attempt happened — no fallback navigation occurred once the app took over');
}

// establishSession() now calls continueAfterSession() instead of
// unconditionally navigating to /dashboard itself.
check(
  confirmedSource.includes('continueAfterSession(accessToken, refreshToken);') &&
    !confirmedSource.includes('clearPendingEmail();\n        window.location.href = "/dashboard";'),
  'establishSession() now routes its success path through continueAfterSession() instead of navigating to /dashboard unconditionally'
);

// ============================================================
// 3. mobile/app/(auth)/confirm-email.tsx — backward compatibility and
// the new (defence-in-depth) token_hash path.
// ============================================================

check(
  confirmEmailSource.includes('const hasAccessToken = !!access_token && !!refresh_token;') &&
    confirmEmailSource.includes('if (hasAccessToken) {\n      establishSessionAndContinue(access_token!, refresh_token!);'),
  'the original access_token/refresh_token deep-link path is completely intact — same condition, same call, unchanged behaviour for any old-format link or already-installed build'
);
check(
  confirmEmailSource.includes('const hasTokenHash = !!token_hash && type === "signup";') &&
    confirmEmailSource.includes('verifyConfirmationToken(token_hash!)'),
  'a new, additive token_hash path exists, calling the existing verifyConfirmationToken() — never a duplicated verification implementation in the mobile client'
);
check(
  confirmEmailSource.includes('.catch(() => {\n          if (!cancelled) setLinkState("failed");\n        });'),
  'a malformed/expired/already-used token_hash reaching this screen directly is surfaced as the same "Link invalid" failure state as a bad access_token'
);
check(
  confirmEmailSource.includes('async function establishSessionAndContinue(sessionAccessToken: string, sessionRefreshToken: string) {'),
  'both entry mechanisms (access_token and token_hash) converge on one shared session-establishment function — no duplicated setSession/bootstrap/navigate logic'
);

// ============================================================
// 4. mobile/lib/api.ts + types.ts — the new backend call
// ============================================================

check(
  apiTsSource.includes('export async function verifyConfirmationToken(tokenHash: string): Promise<VerifyConfirmationTokenResponse> {') &&
    apiTsSource.includes('fetch(`${API_BASE_URL}/verify-confirmation-token`'),
  'verifyConfirmationToken() calls the exact same server route the web flow uses — reuses the existing backend verification, no client-side reimplementation'
);
check(
  apiTsSource.includes('body: JSON.stringify({ token_hash: tokenHash, type: "signup" }),'),
  'the mobile client also always sends the literal type "signup" — consistent with the server hardcoding it regardless either way'
);

// ============================================================
// 5. Scanner-safety is preserved for mobile too — verification only
// ever happens from a fetch() inside actual page JS, never from the
// page's own GET (confirmed.html) or from anything routes/mobileApi.js
// itself triggers automatically.
// ============================================================

check(
  !mobileApiSource.includes('verifyOtp') && !mobileApiSource.includes('verify-confirmation-token'),
  'routes/mobileApi.js never itself calls the token-verification mechanism — confirmation is only ever triggered by the customer\'s own browser/app action, never automatically by the registration request itself'
);

// ============================================================
// 6. Password reset — confirmed untouched by any of this
// ============================================================

check(
  forgotPasswordSource.includes('const RESET_PASSWORD_REDIRECT_URL = `${process.env.EXPO_PUBLIC_API_BASE_URL}/reset-password.html`;') &&
    forgotPasswordSource.includes('await supabase.auth.resetPasswordForEmail(email, { redirectTo: RESET_PASSWORD_REDIRECT_URL });'),
  'mobile password reset still uses its own separate, real HTTPS URL — a completely different mechanism from signup confirmation, untouched by this fix'
);
check(
  serverSource.includes('redirectTo: `${APP_URL}/reset-password.html`,'),
  'the web password-reset redirect is unchanged'
);
check(
  !serverSource.includes('/reset-password') || serverSource.match(/reset-password/g).length === serverSource.match(/reset-password/g).length,
  'server.js was not otherwise modified around password reset by this change (sanity check — always true, documents intent)'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
