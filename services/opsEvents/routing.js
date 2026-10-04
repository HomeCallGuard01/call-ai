// Delivery routing by RECIPIENT ROLE (soft-launch integration 2026-10-04).
// No address is hard-coded: each role's address comes from configuration.
//   OPS_NOTIFY_EMAIL_ENABLED=true            email channel on (default OFF)
//   OPS_NOTIFY_ROLE_OPERATIONS_EMAIL         e.g. the future operations@ mailbox
//   OPS_NOTIFY_FOUNDER_EARLY_LAUNCH=true     also notify the founder role (early launch)
//   OPS_NOTIFY_ROLE_FOUNDER_EMAIL            the founder role's address
//   OPS_NOTIFY_PUSH_ENABLED=true             future admin-app push (no adapter yet ⇒ disabled)
// The dashboard needs no delivery row: the ops_events row IS the dashboard
// alert (unseen until an admin marks it seen).
'use strict';

const ROLES = Object.freeze({ OPERATIONS: 'operations', FOUNDER: 'founder' });

function plannedDeliveries(event, env = process.env) {
  const emailOn = env.OPS_NOTIFY_EMAIL_ENABLED === 'true';
  const roles = [ROLES.OPERATIONS];
  if (env.OPS_NOTIFY_FOUNDER_EARLY_LAUNCH === 'true') roles.push(ROLES.FOUNDER);
  const out = roles.map((role) => ({ channel: 'email', recipient_role: role, status: emailOn ? 'pending' : 'disabled' }));
  out.push({ channel: 'push', recipient_role: ROLES.OPERATIONS, status: env.OPS_NOTIFY_PUSH_ENABLED === 'true' ? 'pending' : 'disabled' });
  return out;
}

function recipientFor(channel, role, env = process.env) {
  if (channel !== 'email') return null;
  const v = env[`OPS_NOTIFY_ROLE_${String(role).toUpperCase()}_EMAIL`];
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? v.trim() : null;
}

module.exports = { ROLES, plannedDeliveries, recipientFor };
