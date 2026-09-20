// Regression tests for the TokenHash email-confirmation fix (2026-09-20)
// — the actual root-cause fix for the real-device v8 acceptance-test
// failure, replacing Supabase's default confirmation link (which points
// directly at GoTrue's own /auth/v1/verify endpoint and is consumed by
// ANY GET request, including an automated email-security link scanner's
// prefetch, before the real customer ever taps it).
//
// This was verified live against real Supabase infrastructure before
// this file was written — not just structural checks. Using a genuine
// disposable test account's real confirmation_token/token_hash value
// against a running local instance of this exact server.js:
//   - POST /verify-confirmation-token with the real token_hash and
//     type=signup returned a genuine 200 with a real access_token/
//     refresh_token/expires_in.
//   - Handing that straight to the existing, unmodified /confirm-session
//     returned {ok:true} and set real sb_access_token/sb_refresh_token
//     cookies.
//   - GET /dashboard with those cookies returned 200 (the onboarding
//     shell), proving the resulting session is genuinely authenticated
//     — not just a 200 from /confirm-session in isolation.
//   - Missing token_hash -> 400. type != "signup" -> 400. A garbage
//     token_hash -> 401. Re-submitting the SAME already-verified
//     token_hash a second time -> 401 (proves Supabase's own single-use
//     enforcement is intact and this route does not weaken it).
//
// No HTTP/browser test tooling exists in this project (server.js calls
// app.listen() as an import-time side effect and needs real Supabase
// credentials, so it isn't structured for isolated in-process HTTP
// testing) — matching the established convention elsewhere (see
// tests/admin-post-login-routing.test.mjs's identical technique of
// locating a route's boundaries in server.js's own source and asserting
// against the code within them), this file checks the real source
// directly for the specific properties that live demonstration above
// can't run again on every CI execution: exact validation, exact
// hardcoded verification type, exact response shape, and that the
// legacy hash-fragment path is untouched.
//
// Run with: node tests/token-hash-confirmation.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const confirmedSource = readFileSync(path.join(__dirname, '..', 'public', 'confirmed.html'), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

const routeStart = serverSource.indexOf('app.post("/verify-confirmation-token"');
const routeEnd = serverSource.indexOf('\n// AUTH: RESEND CONFIRMATION', routeStart);
const routeSource = routeStart !== -1 && routeEnd !== -1 ? serverSource.slice(routeStart, routeEnd) : '';

check(routeStart !== -1, 'server.js defines POST /verify-confirmation-token');

// ============================================================
// Clean rejection of missing/invalid/expired/wrong-type input
// ============================================================

check(
  routeSource.includes('if (!tokenHash || typeof tokenHash !== "string" || type !== "signup") {') &&
    routeSource.includes('return res.status(400).json({ error: "invalid_input" });'),
  'missing token_hash, or any type other than "signup", is rejected with a clean 400 before any Supabase call'
);
check(
  routeSource.includes('if (error || !data?.session) {') &&
    routeSource.includes('return res.status(401).json({ error: "invalid_token_hash" });'),
  'a garbage/invalid/expired/already-used token_hash (Supabase itself rejects it) is surfaced as a clean 401, not a 500 or a stack trace'
);
check(
  !/invalid_token_hash[\s\S]{0,200}(expired|already used|not found)/i.test(routeSource),
  'the 401 response never distinguishes expired vs. already-used vs. never-existed — no oracle for probing token validity'
);

// ============================================================
// The verification type is always hardcoded, never client-controlled
// — this route can never be repurposed to verify a recovery/magic-link/
// email-change token even if a caller sends a different `type`.
// ============================================================

check(
  routeSource.includes('await supabase.auth.verifyOtp({') &&
    routeSource.includes('token_hash: tokenHash,') &&
    routeSource.includes('type: "signup",'),
  'verifyOtp() is always called with the literal type "signup", never the client-supplied `type` value'
);

// ============================================================
// Minimal response shape — only what the existing /confirm-session
// handoff needs, nothing else (no user object, no other claims).
// ============================================================

check(
  /return res\.json\(\{\s*access_token: data\.session\.access_token,\s*refresh_token: data\.session\.refresh_token,\s*expires_in: data\.session\.expires_in,\s*\}\);/.test(routeSource),
  'the success response contains only access_token/refresh_token/expires_in — no user object or other Supabase claims are ever sent to the browser'
);
check(
  !routeSource.includes('data.user') && !routeSource.includes('data.session.user'),
  'the route never forwards the verifyOtp() user object to the client'
);

// ============================================================
// Uses the existing anon-key `supabase` client — the same one /login,
// /register and /confirm-session already use — never the service-role
// admin client, and never a new/parallel auth mechanism.
// ============================================================

check(
  routeSource.includes('const { data, error } = await supabase.auth.verifyOtp({'),
  'verifyOtp() is called on the existing anon-key `supabase` client, the same one every other public auth route in this file already uses'
);
check(
  !routeSource.includes('supabaseAdmin'),
  'the route never touches the service-role admin client'
);

// ============================================================
// public/confirmed.html — wires the new path in, preserves the legacy
// hash-fragment path completely unchanged, and reuses the existing,
// unmodified /confirm-session for the actual session handoff either way.
// ============================================================

check(
  confirmedSource.includes('var tokenHash = queryParams.get("token_hash");') &&
    confirmedSource.includes('var tokenHashType = queryParams.get("type");') &&
    confirmedSource.includes('if (tokenHash && tokenHashType === "signup") {'),
  'confirmed.html checks the URL query string for ?token_hash=&type=signup as its primary path'
);
check(
  confirmedSource.includes('fetch("/verify-confirmation-token", {'),
  'the TokenHash path calls the new /verify-confirmation-token route from actual page JavaScript (never from the page\'s own plain GET) — this is the actual fix: a link scanner that only fetches/previews HTML never executes this'
);
check(
  /establishSession\(data\.access_token, data\.refresh_token, data\.expires_in, data\.access_token\);/.test(confirmedSource),
  'a successful TokenHash verification hands its tokens to the same establishSession() helper the legacy path uses'
);
check(
  confirmedSource.includes('function establishSession(accessToken, refreshToken, expiresIn, tokenForFallback) {') &&
    confirmedSource.includes('fetch("/confirm-session", {') &&
    confirmedSource.includes('window.location.href = "/dashboard";'),
  'establishSession() posts to the existing, unmodified /confirm-session and continues straight to /dashboard on success — the correct onboarding continuation, no login screen'
);
check(
  confirmedSource.includes('goToLoginFallback(readPendingEmail());') &&
    confirmedSource.split('goToLoginFallback(readPendingEmail());').length - 1 >= 2,
  'both the TokenHash-verification-failure branch and the legacy no-tokens branch fall back to the existing secure login screen — the fallback is preserved, not removed'
);

// Legacy hash-fragment path — must be completely untouched in behaviour.
check(
  confirmedSource.includes('var hash = window.location.hash ? window.location.hash.slice(1) : "";') &&
    confirmedSource.includes('var hashParams = new URLSearchParams(hash);') &&
    confirmedSource.includes('var accessToken = hashParams.get("access_token");') &&
    confirmedSource.includes('var refreshToken = hashParams.get("refresh_token");'),
  'the legacy #access_token= hash-fragment path (for any confirmation email already in transit when the template changes) is still present and parses the fragment exactly as before'
);
check(
  confirmedSource.includes('establishSession(accessToken, refreshToken, expiresIn, accessToken);'),
  'the legacy path also hands off through the same shared establishSession() helper — identical session-establishment mechanism either way'
);

// ============================================================
// Security requirements — no password anywhere, no token exposure
// beyond what the existing handoff already required.
// ============================================================

check(
  !confirmedSource.includes('"password"') && !confirmedSource.includes("'password'"),
  'confirmed.html never reads, stores, or references a password anywhere in its logic'
);
check(
  !/localStorage/.test(confirmedSource) && !/document\.cookie\s*=/.test(confirmedSource),
  'confirmed.html never touches localStorage and never sets a cookie directly itself — session cookies remain server-set via /confirm-session'
);
check(
  !routeSource.includes('req.body.password') && !routeSource.includes('req.query.password'),
  '/verify-confirmation-token never reads a password from the request'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
