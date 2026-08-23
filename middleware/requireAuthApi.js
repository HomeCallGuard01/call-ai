const { supabase } = require("../services/supabaseClients");
const { getHouseholdByAuthUserId, getUserRole } = require("../database/households");

// Bearer-token counterpart to middleware/requireAuth.js — same
// verify-then-refresh-then-load-household logic, but reads the token from
// an `Authorization: Bearer <token>` header instead of a cookie, and
// responds with JSON on every failure instead of redirecting to
// /login.html. requireAuth exists to serve the web app's cookie/redirect
// model; this exists to serve the mobile app's bearer-token model — see
// APP_DECISION_005 in docs/mobile-app/. Deliberately a parallel middleware,
// not a modification of requireAuth, so the existing web routes and their
// tested behaviour are completely untouched by this addition.
//
// Unlike requireAuth, there is no server-side session to refresh cookies
// into — a mobile client holds its own refresh token (via the Supabase
// client SDK + SecureStore) and is responsible for retrying with a
// refreshed access token itself. This middleware only ever validates the
// access token it's given; a 401 here means "get a new access token and
// retry," which the app's own Supabase client handles automatically on
// every other call already.
// Verifies just the bearer token itself — no household requirement.
// Extracted so /api/v1/me/bootstrap (routes/mobileApi.js) can use the
// exact same token-verification logic without requiring a household to
// already exist, which would be a chicken-and-egg problem for the one
// endpoint whose entire job is to create that household in the first
// place. Returns { userId, email } or null; never throws.
async function verifyBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return null;
  }

  const { data: userData, error } = await supabase.auth.getUser(token);

  if (error || !userData?.user) {
    return null;
  }

  return { userId: userData.user.id, email: userData.user.email, token };
}

async function requireAuthApi(req, res, next) {
  const verified = await verifyBearerToken(req);

  if (!verified) {
    return res.status(401).json({ error: "unauthenticated" });
  }

  const household = await getHouseholdByAuthUserId(verified.userId);

  if (!household) {
    return res.status(401).json({ error: "no_household" });
  }

  req.household = household;
  req.authUserId = verified.userId;
  req.role = await getUserRole(verified.userId);

  next();
}

module.exports = { requireAuthApi, verifyBearerToken };
