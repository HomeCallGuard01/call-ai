const { supabase } = require("../services/supabaseClients");
const { getHouseholdByAuthUserId, getUserRole } = require("../database/households");

const ACCESS_COOKIE = "sb_access_token";
const REFRESH_COOKIE = "sb_refresh_token";

function setSessionCookies(res, session) {
  const isProd = process.env.NODE_ENV === "production";

  res.cookie(ACCESS_COOKIE, session.access_token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    maxAge: session.expires_in * 1000,
  });

  res.cookie(REFRESH_COOKIE, session.refresh_token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookies(res) {
  res.clearCookie(ACCESS_COOKIE);
  res.clearCookie(REFRESH_COOKIE);
}

// Verifies the session cookie, refreshing it if the access token has expired,
// then resolves the household that belongs to the verified auth user — never
// from anything client-supplied. Redirects to login on any failure.
async function requireAuth(req, res, next) {
  const accessToken = req.cookies?.[ACCESS_COOKIE];
  const refreshToken = req.cookies?.[REFRESH_COOKIE];

  if (!accessToken) {
    return res.redirect("/login.html");
  }

  let userId = null;

  const { data: userData } = await supabase.auth.getUser(accessToken);

  if (userData?.user) {
    userId = userData.user.id;
  } else if (refreshToken) {
    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (refreshError || !refreshed?.session) {
      clearSessionCookies(res);
      return res.redirect("/login.html");
    }

    setSessionCookies(res, refreshed.session);
    userId = refreshed.session.user.id;
  } else {
    clearSessionCookies(res);
    return res.redirect("/login.html");
  }

  const household = await getHouseholdByAuthUserId(userId);

  if (!household) {
    clearSessionCookies(res);
    return res.redirect("/login.html");
  }

  req.household = household;
  req.authUserId = userId;
  req.role = await getUserRole(userId);

  next();
}

module.exports = {
  requireAuth,
  setSessionCookies,
  clearSessionCookies,
  ACCESS_COOKIE,
  REFRESH_COOKIE,
};
