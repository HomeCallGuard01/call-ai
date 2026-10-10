'use strict';

// Unauthenticated auth-endpoint rate limits — integration 2026-10-03
// (Launch Fortress; launch-gate PR-11 / A8 / C8).
//
// Threats: email-bombing a victim through /forgot-password and
// /resend-confirmation (HCG's email sender is the weapon), scripted mass
// sign-up (/register, /api/v1/register), credential stuffing on /login, and
// junk rows through /api/v1/waiting-list. No paid telephony resource is
// created by any of these routes (a number is only bought after payment, and
// purchases are gated by the Financial Fortress), so these limits protect the
// email channel, the database and the customer — not telephony spend.
//
// Three layers, every threshold env-tunable:
//   1. per TARGET EMAIL (normalised) — independent of any proxy, so it is
//      reliable on Railway today. Email-sending routes SUPPRESS the send but
//      answer identically (no account enumeration); others answer 429.
//   2. per ROUTE, global — a ceiling against floods from many sources. Set
//      high so a genuine launch spike is not refused.
//   3. per CLIENT IP — ONLY when TRUST_PROXY_HOPS is set (and server.js sets
//      app "trust proxy" to match). Without it every request appears to come
//      from the proxy, and a per-IP limit would silently become a global one.
//
// LIMITATION (PARTIAL): counters are process-local. With N instances the
// effective ceilings are N×; a restart clears them. Supabase Auth's own
// per-project limits still apply underneath.

const WINDOW_MS = 10 * 60 * 1000;

function envInt(env, name, fallback) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function normaliseEmailKey(raw) {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1 || at === e.length - 1) return null;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

function createWindowCounter({ now = () => Date.now(), maxKeys = 50000 } = {}) {
  const hits = new Map(); // key -> [timestamps]
  return {
    hit(key, windowMs) {
      const t = now();
      const list = (hits.get(key) || []).filter((x) => x > t - windowMs);
      list.push(t);
      hits.set(key, list);
      if (hits.size > maxKeys) hits.delete(hits.keys().next().value);
      return list.length;
    },
  };
}

/**
 * @param {object} opts
 * @param {string} opts.route            label used in keys and logs
 * @param {'reject'|'suppress'} opts.onEmailLimit  email-sending routes suppress
 */
function createAuthEndpointLimiter({ env = process.env, now, log = console.error } = {}) {
  const counter = createWindowCounter({ now });
  const config = {
    windowMs: envInt(env, 'AUTH_RATE_WINDOW_MS', WINDOW_MS),
    perEmail: envInt(env, 'AUTH_RATE_PER_EMAIL', 3),
    perIp: envInt(env, 'AUTH_RATE_PER_IP', 30),
    global: {
      register: envInt(env, 'AUTH_RATE_GLOBAL_REGISTER', 300),
      login: envInt(env, 'AUTH_RATE_GLOBAL_LOGIN', 1200),
      email: envInt(env, 'AUTH_RATE_GLOBAL_EMAIL', 200),
      waiting_list: envInt(env, 'AUTH_RATE_GLOBAL_WAITING_LIST', 300),
      // WS1 2026-10-10: token-exchange routes (/confirm-session,
      // /verify-confirmation-token, /reset-password-verify,
      // /reset-password-complete). No email is sent, but each request calls
      // Supabase Auth from THIS server's IP (a flood would exhaust Supabase's
      // per-IP auth limits for every genuine customer) and may write a
      // households/user_roles row.
      session: envInt(env, 'AUTH_RATE_GLOBAL_SESSION', 600),
      // WS1 2026-10-10: unauthenticated analytics writes (GET / and GET /go
      // landing_visit rows). Used through budget(): the page is always
      // served; only the database write is skipped over the ceiling.
      acquisition: envInt(env, 'AUTH_RATE_GLOBAL_ACQUISITION', 3000),
    },
    ipEnabled: Number(env.TRUST_PROXY_HOPS) > 0,
  };

  function assertKnownGroup(group) {
    // An unknown group would silently have NO global ceiling (count > undefined
    // is always false) — refuse at wiring time instead.
    if (!Object.prototype.hasOwnProperty.call(config.global, group)) {
      throw new Error(`authEndpointRateLimit: unknown group "${group}"`);
    }
  }

  function limit(route, { group, onEmailLimit = 'reject', emailField = 'email' }) {
    assertKnownGroup(group);
    return function authRateLimit(req, res, next) {
      const tooMany = (reason) => {
        log('AUTH RATE LIMIT', JSON.stringify({ route, reason }));
        // JSON callers (the app, and the token-exchange routes' page scripts) get JSON.
        if (req.path.startsWith('/api/') || (typeof req.is === 'function' && req.is('application/json'))) return res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Please wait a few minutes and try again.' });
        return res.status(429).type('text/plain').send('Too many attempts. Please wait a few minutes and try again.');
      };
      if (counter.hit(`g:${group}`, config.windowMs) > config.global[group]) return tooMany('global');
      if (config.ipEnabled && req.ip && counter.hit(`ip:${group}:${req.ip}`, config.windowMs) > config.perIp) return tooMany('ip');
      const emailKey = emailField ? normaliseEmailKey(req.body && req.body[emailField]) : null;
      if (emailKey && counter.hit(`e:${route}:${emailKey}`, 60 * 60 * 1000) > config.perEmail) {
        if (onEmailLimit === 'suppress') {
          // Identical response, no email sent (no enumeration, no bombing).
          log('AUTH RATE LIMIT', JSON.stringify({ route, reason: 'email_suppressed' }));
          req.authEmailSuppressed = true;
          return next();
        }
        return tooMany('email');
      }
      return next();
    };
  }

  // Non-responding variant for side effects that must never block the page
  // they ride on (e.g. landing-visit analytics): consumes the group's global
  // and (when TRUST_PROXY_HOPS is set) per-IP budget and returns whether the
  // side effect may run. Never touches the response.
  function budget(group, req) {
    assertKnownGroup(group);
    if (counter.hit(`g:${group}`, config.windowMs) > config.global[group]) return false;
    if (config.ipEnabled && req && req.ip && counter.hit(`ip:${group}:${req.ip}`, config.windowMs) > config.perIp) return false;
    return true;
  }

  return { limit, budget, config };
}

// WS1 2026-10-10: ONE process-wide limiter shared by server.js and
// routes/mobileApi.js. Previously each file created its own, so the web and
// mobile copies of the same action (sign-up, resend confirmation) each had
// their own per-mailbox and global budgets — a victim's mailbox could receive
// double the intended number of emails. Same route labels now share counters.
let shared = null;
function sharedAuthEndpointLimiter() {
  if (!shared) shared = createAuthEndpointLimiter();
  return shared;
}

module.exports = { createAuthEndpointLimiter, sharedAuthEndpointLimiter, normaliseEmailKey };
