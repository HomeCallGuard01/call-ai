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
async function requireAuthApi(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "unauthenticated" });
  }

  const { data: userData, error } = await supabase.auth.getUser(token);

  if (error || !userData?.user) {
    return res.status(401).json({ error: "unauthenticated" });
  }

  const userId = userData.user.id;
  const household = await getHouseholdByAuthUserId(userId);

  if (!household) {
    return res.status(401).json({ error: "no_household" });
  }

  req.household = household;
  req.authUserId = userId;
  req.role = await getUserRole(userId);

  next();
}

module.exports = { requireAuthApi };
