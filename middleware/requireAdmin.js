// Must run after requireAuth (needs req.role, set there from user_roles).
// Distinct from requireEntitlement: this is not about whether a household
// pays, it's about whether the logged-in person is allowed to see other
// households' data at all. Redirects (not a JSON 403) since every route
// this guards is a full-page navigation or is only ever called from pages
// already gated by the page-level check.
function requireAdmin(req, res, next) {
  if (req.role !== "admin") {
    return res.redirect("/dashboard");
  }

  next();
}

module.exports = { requireAdmin };
