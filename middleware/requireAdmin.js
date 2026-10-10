// Must run after requireAuth (needs req.role, set there from user_roles).
// Distinct from requireEntitlement: this is not about whether a household
// pays, it's about whether the logged-in person is allowed to see other
// households' data at all. Redirects (not a JSON 403) since every route
// this guards is a full-page navigation or is only ever called from pages
// already gated by the page-level check.
//
// WS1 2026-10-10 (admin hardening, no new infrastructure): every admin
// MUTATION (POST/PUT/PATCH/DELETE) is also rate-limited per admin user, here,
// so every current and future admin route that already mounts requireAdmin is
// covered without touching the route files. Bounds the blast radius of a
// stolen admin session or a runaway script (kill switch flapping, mass
// complimentary grants, mass deactivation, proof records). Reads are not
// limited. In-memory, per process (same documented limitation as
// middleware/householdRateLimit.js). Tunable:
//   ADMIN_MUTATION_RATE_LIMIT      mutations per window per admin (default 60)
//   ADMIN_MUTATION_RATE_WINDOW_MS  window length (default 10 minutes)
const { createHouseholdRateLimiter } = require("./householdRateLimit");

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function createAdminMutationLimiter({ env = process.env, now } = {}) {
  return createHouseholdRateLimiter({
    name: "admin_mutation",
    limit: positiveInt(env.ADMIN_MUTATION_RATE_LIMIT, 60),
    windowMs: positiveInt(env.ADMIN_MUTATION_RATE_WINDOW_MS, 10 * 60 * 1000),
    ...(now ? { now } : {}),
  });
}

function createRequireAdmin({ limiter = createAdminMutationLimiter(), log = console.error } = {}) {
  return function requireAdmin(req, res, next) {
    if (req.role !== "admin") {
      return res.redirect("/dashboard");
    }

    if (MUTATING_METHODS.has(req.method)) {
      // Keyed by the verified auth user (set by requireAuth), never by
      // anything client-supplied; falls back to the household id.
      const key = req.authUserId || (req.household && req.household.id) || "unknown-admin";
      const result = limiter.check(`admin:${key}`);
      if (!result.allowed) {
        log("ADMIN MUTATION RATE LIMITED", JSON.stringify({ path: req.path, method: req.method }));
        res.set("Retry-After", String(result.retryAfterSeconds));
        return res.status(429).json({ error: "rate_limited", message: "Too many admin changes in a short time. Wait a few minutes and try again." });
      }
    }

    next();
  };
}

const requireAdmin = createRequireAdmin();

module.exports = { requireAdmin, createRequireAdmin, createAdminMutationLimiter, MUTATING_METHODS };
