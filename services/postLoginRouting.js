// postLoginRouting.js — pure post-login/dashboard-navigation decisions
// (2026-09 fix). Extracted from server.js so this logic is directly
// unit-testable (server.js has no exports and calls app.listen() at
// module load time, same reason services/registrationFlow.js and
// services/householdBootstrap.js exist as separate files).
//
// Admin authorisation and customer entitlement are deliberately kept as
// two separate inputs here, never merged into one concept — neither
// function ever grants, checks, or implies a customer entitlement; they
// only ever redirect an already-authenticated admin session to the
// admin dashboard instead of the customer one. requireEntitlement and
// every consumer/API route it gates are completely independent of this
// file and never call into it.
'use strict';

// Pure — decides where a freshly-authenticated session should land
// immediately after /login succeeds. Admin-authorisation only, never a
// customer-entitlement check: an admin account has no reason to ever
// see the customer membership/paywall screen after logging in. A
// non-admin role always continues through the existing customer
// dashboard/onboarding/membership flow, completely unchanged.
function decidePostLoginRedirect({ role }) {
  return role === 'admin' ? '/admin/business' : '/dashboard';
}

// Pure — decides whether a request to the ordinary customer /dashboard
// route should instead be redirected to the admin dashboard. Only ever
// true for role='admin' with NO active consumer entitlement — an admin
// who genuinely also holds an active entitlement (e.g. their own real
// household) sees the normal customer dashboard exactly like any other
// entitled household, so this can never be mistaken for an entitlement
// bypass: it only ever redirects away from the customer view, never
// grants access to anything within it.
function decideDashboardRouteRedirect({ role, hasActiveEntitlement }) {
  if (role === 'admin' && !hasActiveEntitlement) {
    return '/admin/business';
  }
  return null;
}

module.exports = { decidePostLoginRedirect, decideDashboardRouteRedirect };
