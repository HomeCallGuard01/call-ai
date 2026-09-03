// Regression tests for the confirm-gated token_hash password-reset flow
// (public/reset-password.html + server.js's /reset-password-verify).
//
// Background: a freshly-generated, legitimate Supabase recovery link was
// coming back "invalid" because the old flow's emailed link pointed
// straight at GoTrue's auto-consuming /verify endpoint — any automated
// mail-scanner/prefetch fetching that link permanently used up the
// one-time token before the real click ever happened. The fix routes the
// emailed link at this app's own page with an unconsumed token_hash, and
// only calls Supabase's verifyOtp() from an explicit button click.
//
// Two pure functions (parseRecoveryLink, describeVerifyResponse) are
// extracted from the real page markup via TEST-EXTRACT markers, matching
// this codebase's existing convention (see tests/dashboard-status.test.mjs).
// The click-handler wiring and the "never logs a token" property are
// checked structurally against the real source, since there's no DOM/
// browser test tooling in this project.
//
// Run with: node tests/reset-password-token-hash.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'public', 'reset-password.html'), 'utf8');
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

function extractBetween(source, name) {
  const startMarker = `// TEST-EXTRACT-START: ${name}`;
  const endMarker = `// TEST-EXTRACT-END: ${name}`;
  const startIdx = source.indexOf(startMarker);
  const endIdx = source.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    return null;
  }
  return source.slice(startIdx + startMarker.length, endIdx);
}

const parseRecoveryLinkSource = extractBetween(html, 'parseRecoveryLink');
const describeVerifyResponseSource = extractBetween(html, 'describeVerifyResponse');
const clickHandlerSource = extractBetween(html, 'continueButtonClickHandler');

if (!parseRecoveryLinkSource || !describeVerifyResponseSource || !clickHandlerSource) {
  console.error('✗ could not find one or more expected TEST-EXTRACT markers in public/reset-password.html — test cannot run');
  failures++;
} else {
  // FRIENDLY_ERROR_MESSAGES is referenced by both extracted functions but
  // declared just above the first marker in the real file — redeclared
  // here identically so the extracted source runs standalone.
  const combinedSource = `
    var FRIENDLY_ERROR_MESSAGES = {
      otp_expired: "This reset link has already been used or has expired.",
      access_denied: "This reset link is no longer valid.",
      invalid: "This reset link is no longer valid.",
    };
    ${parseRecoveryLinkSource}
    ${describeVerifyResponseSource}
    return { parseRecoveryLink, describeVerifyResponse };
  `;
  const { parseRecoveryLink, describeVerifyResponse } = new Function(combinedSource)();

  // --- parseRecoveryLink: the new confirm-gated (token_hash) shape ---

  check(
    parseRecoveryLink('?token_hash=abc123&type=recovery', '').mode === 'confirm',
    'parseRecoveryLink: a query-string token_hash + type=recovery is recognised as the new confirm-gated flow'
  );

  check(
    parseRecoveryLink('?token_hash=abc123&type=recovery', '').tokenHash === 'abc123',
    'parseRecoveryLink: the raw token_hash value is preserved for the later, explicit verify call'
  );

  check(
    parseRecoveryLink('?token_hash=abc123&type=signup', '').mode !== 'confirm',
    'parseRecoveryLink: a token_hash with any type other than "recovery" is never treated as a password-reset confirm link'
  );

  // --- parseRecoveryLink: the old hash-fragment (implicit) shape, preserved ---

  check(
    parseRecoveryLink('', '#access_token=tok&refresh_token=ref&type=recovery').mode === 'session',
    'parseRecoveryLink: the old access_token/refresh_token hash fragment shape still works, for in-flight emails and the mobile handoff'
  );

  check(
    parseRecoveryLink('', '#error=access_denied&error_code=otp_expired').mode === 'error',
    'parseRecoveryLink: GoTrue\'s own rejection fragment is recognised as an error, not silently treated as "missing"'
  );

  check(
    parseRecoveryLink('', '#error=access_denied&error_code=otp_expired').message ===
      'This reset link has already been used or has expired.',
    'parseRecoveryLink: an expired/already-used token gets the specific, accurate message — the fix for the original misleading "missing or invalid" text'
  );

  check(
    parseRecoveryLink('', '').mode === 'invalid',
    'parseRecoveryLink: no query token_hash and no hash fragment at all falls back to the generic invalid-link message'
  );

  // --- describeVerifyResponse: server round-trip outcomes ---

  check(
    describeVerifyResponse(true, { ok: true, access_token: 'tok', refresh_token: 'ref' }).next === 'show-password-form',
    'describeVerifyResponse: a successful /reset-password-verify response leads to the password-reset form — the flow reaches completion'
  );

  check(
    (() => {
      const decision = describeVerifyResponse(true, { ok: true, access_token: 'tok', refresh_token: 'ref' });
      return decision.accessToken === 'tok' && decision.refreshToken === 'ref';
    })(),
    'describeVerifyResponse: the session tokens returned by the server are carried through to the next step unchanged'
  );

  check(
    describeVerifyResponse(false, { error: 'invalid' }).next === 'show-error',
    'describeVerifyResponse: an invalid/expired token from the server is handled safely (a defined error outcome, not a thrown exception or a false success)'
  );

  check(
    (() => {
      try {
        describeVerifyResponse(false, null);
        return true;
      } catch {
        return false;
      }
    })(),
    'describeVerifyResponse: a malformed/empty response body never throws — degrades to the generic error outcome'
  );
}

// --- Structural checks: the token is only ever sent from the button click ---

// Everything in the inline <script> up to the click-handler block is
// "page load" code — it must never itself call /reset-password-verify.
const clickHandlerStart = html.indexOf('// TEST-EXTRACT-START: continueButtonClickHandler');
const clickHandlerEnd = html.indexOf('// TEST-EXTRACT-END: continueButtonClickHandler');
const scriptStart = html.indexOf('<script>');
const scriptEnd = html.indexOf('</script>');

if (clickHandlerStart === -1 || clickHandlerEnd === -1 || scriptStart === -1 || scriptEnd === -1) {
  console.error('✗ could not locate the click-handler markers or the <script> block — structural checks cannot run');
  failures++;
} else {
  const pageLoadSource = html.slice(scriptStart, clickHandlerStart) + html.slice(clickHandlerEnd, scriptEnd);
  const clickHandlerBlock = html.slice(clickHandlerStart, clickHandlerEnd);

  check(
    !pageLoadSource.includes('fetch("/reset-password-verify"'),
    'page load never calls /reset-password-verify — only code inside the button\'s click handler does, so a mail scanner/prefetcher fetching the HTML cannot consume the token'
  );

  check(
    clickHandlerBlock.includes('fetch("/reset-password-verify"'),
    'the explicit "Continue to reset password" button click handler is what actually triggers verification'
  );

  check(
    clickHandlerBlock.includes('getElementById("continueButton").addEventListener("click"'),
    'the verification call is wired to a real click event on the continue button, not fired automatically'
  );

  check(
    html.includes('id="confirmPanel" hidden') && html.includes('id="formBox" hidden'),
    'both the confirm-step panel and the password form are hidden by default in markup — nothing is shown or actioned until JS explicitly decides to, based on the parsed link'
  );
}

// --- No token or password is ever logged (client-side) ---

const consoleCallPattern = /console\.(?:log|warn|error|info|debug)\(([^;]*?)\)\s*;/g;
const forbiddenLoggedIdentifiers = ['accessToken', 'refreshToken', 'tokenHash', 'token_hash', 'access_token', 'refresh_token', 'newPassword', 'new_password', 'password'];
let match;
let sawAnyConsoleCall = false;
let loggedForbiddenValue = false;
while ((match = consoleCallPattern.exec(html)) !== null) {
  sawAnyConsoleCall = true;
  const args = match[1];
  if (forbiddenLoggedIdentifiers.some((identifier) => args.includes(identifier))) {
    loggedForbiddenValue = true;
  }
}

check(sawAnyConsoleCall, 'sanity check: the page does log something (the diagnostic error-code warning) — the "no forbidden identifiers" check below isn\'t vacuously true');
check(!loggedForbiddenValue, 'no console.* call in reset-password.html ever logs a token or password — only non-secret diagnostic strings like an error code');

// --- Server route: /reset-password-verify never logs the token or session ---

const routeStart = serverSource.indexOf('app.post("/reset-password-verify"');
const routeEnd = routeStart === -1 ? -1 : serverSource.indexOf('\n});', routeStart);

if (routeStart === -1 || routeEnd === -1) {
  console.error('✗ could not locate the /reset-password-verify route in server.js — structural checks cannot run');
  failures++;
} else {
  const routeBody = serverSource.slice(routeStart, routeEnd);

  check(
    routeBody.includes('express.json()'),
    '/reset-password-verify parses its own JSON body, scoped to this one route (matching this codebase\'s existing per-route express.json() convention), rather than relying on a global JSON parser'
  );

  check(
    routeBody.includes('verifyClient.auth.verifyOtp({ token_hash, type: "recovery" })'),
    '/reset-password-verify uses Supabase\'s token_hash + verifyOtp({ type: "recovery" }) exchange, as required'
  );

  check(
    routeBody.includes('buildUserScopedClient()'),
    '/reset-password-verify uses a fresh, per-request user-scoped client — never the shared admin/anon client — for this one user\'s token, matching /reset-password-complete\'s existing pattern'
  );

  const serverConsolePattern = /console\.(?:log|warn|error|info|debug)\(([^;]*?)\)\s*;/g;
  let serverMatch;
  let routeLoggedForbiddenValue = false;
  while ((serverMatch = serverConsolePattern.exec(routeBody)) !== null) {
    const args = serverMatch[1];
    // error.message is fine (Supabase's own error text, not the token/session
    // itself); token_hash, data.session, access_token, refresh_token are not.
    if (['token_hash', 'data.session', 'access_token', 'refresh_token', 'req.body'].some((identifier) => args.includes(identifier))) {
      routeLoggedForbiddenValue = true;
    }
  }

  check(
    !routeLoggedForbiddenValue,
    '/reset-password-verify never logs the token_hash, the resulting session, or the raw request body — only a safe error message on failure'
  );

  check(
    !routeBody.includes('setSessionCookies'),
    '/reset-password-verify only exchanges the token for a session and returns it to the client — it does not itself establish the logged-in session or touch the password; /reset-password-complete (unchanged) still does both'
  );
}

console.log(failures === 0 ? '\nAll reset-password-token-hash checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
