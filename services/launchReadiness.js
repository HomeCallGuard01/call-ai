// Source of truth for this list is docs/launch/KNOWN_ISSUES.md — this is
// a structured mirror of it for the admin panel, not a second, separately
// maintained list. Update both together when an item's status changes;
// see that file for the full explanation behind each entry.
//
// Dashboard Cleanup audit (2026-09): five of the original six items were
// found stale (already resolved, or describing a mechanism that no
// longer matches reality) against direct evidence gathered this session
// — real production behaviour, git history, and live code inspection,
// not assumption. Each corrected item's `detail` records that evidence.
// Only the solicitor sign-off remains genuinely open — a business/legal
// fact no code artifact can confirm, deliberately left as a non-blocker
// (severity: 'medium', not 'blocker') so the dashboard never reports a
// technical launch blocker that doesn't actually exist.
const ITEMS = [
  {
    title: "Registered office address decision",
    severity: "blocker",
    status: "done",
    detail:
      "Resolved. public/terms.html §1 and its contact section both show a real registered office address (128 City Road, London, EC1V 2NX) — confirmed via git history (commit 6beb640), which replaced the literal '[REGISTERED OFFICE ADDRESS TO BE CONFIRMED]' placeholder. No placeholder markers remain anywhere in the file.",
  },
  {
    title: "Twilio Address object for UK number purchase",
    severity: "blocker",
    status: "done",
    detail:
      "Resolved. Confirmed via real production evidence: multiple UK Twilio numbers have been successfully purchased and assigned to households, most recently within the last few days — the purchase path is demonstrably working in production today.",
  },
  {
    title: "Migration 017 real-database repair",
    severity: "high",
    status: "done",
    detail:
      "Functionally resolved. The migration file's own header previously said 'NOT YET APPLIED', but direct live evidence contradicts it: real assign_household_twilio_number assignments and real twilio_number_pending_release_at grace-period markings both exist and work correctly in production today. The migration's header comment has been corrected to reflect this (matching the same after-the-fact correction already applied to migration 020's header for an identical stale-documentation issue) — no executable SQL was changed.",
  },
  {
    title: "Scheduled runner for expired-number release",
    severity: "medium",
    status: "done",
    detail:
      "Resolved, via a different mechanism than originally proposed. server.js runs runExpiredTwilioNumberRelease() automatically on an in-process timer (shortly after startup, then every 24h) rather than a separate Railway Cron Job — a working, self-healing schedule already exists and is live, so the underlying risk (expired numbers never released) is mitigated.",
  },
  {
    title: "Stripe Customer Portal",
    severity: "medium",
    status: "done",
    detail:
      "Resolved. POST /billing/manage-membership creates a real stripe.billingPortal.sessions.create() session, and it is wired into the live customer dashboard (upload.html's 'Manage Membership' button). Fully built and shipped.",
  },
  {
    title: "Terms & Conditions solicitor sign-off",
    severity: "medium",
    status: "pending",
    detail:
      "Genuinely open — a business/legal follow-up, not a technical blocker. public/terms.html is a considered draft, not a solicitor-reviewed contract. This is a legal fact no code artifact can confirm or deny; recommend UK consumer-law review before relying on it in a dispute. Deliberately kept at medium severity (not blocker) so this dashboard never reports a technical launch blocker that doesn't exist.",
  },
];

function getLaunchReadinessItems() {
  return ITEMS;
}

module.exports = { getLaunchReadinessItems };
