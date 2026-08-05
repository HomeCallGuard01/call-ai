// Source of truth for this list is docs/launch/KNOWN_ISSUES.md — this is
// a structured mirror of it for the admin panel, not a second, separately
// maintained list. Update both together when an item's status changes;
// see that file for the full explanation behind each entry.
const ITEMS = [
  {
    title: "Registered office address decision",
    severity: "blocker",
    status: "resolved",
    detail:
      "Resolved: 128 City Road, London, EC1V 2NX, United Kingdom (AFMD Ltd's registered office) is now stated in public/terms.html §1 and public/privacy.html §1. This unblocks the Twilio Address object item below.",
  },
  {
    title: "Twilio Address object for UK number purchase",
    severity: "blocker",
    status: "pending",
    detail:
      "Twilio's real purchase API rejected a test attempt: an AddressSid is required for UK local numbers. The registered office address decision above is now resolved (128 City Road, London, EC1V 2NX) — the remaining work is creating the Twilio Address object itself and wiring its SID through buildIncomingPhoneNumberParams() in services/twilioProvisioning.js, not a further business decision.",
  },
  {
    title: "Migration 017 real-database repair",
    severity: "high",
    status: "in_progress",
    detail:
      "Currently paused pending Supabase support — a verified, working database change (assign_household_twilio_number) was found to have silently reverted, with no infrastructure cause identified. See docs/engineering/016_017_migration_incident_notes.md.",
  },
  {
    title: "Scheduled runner for expired-number release",
    severity: "medium",
    status: "pending",
    detail:
      "scripts/release-expired-twilio-numbers.js works but nothing invokes it on a schedule yet. Needs a daily Railway Cron Job before the first cancellation's 30-day window elapses.",
  },
  {
    title: "Stripe Customer Portal",
    severity: "medium",
    status: "pending",
    detail:
      "Manage-subscription, cancel, and reactivate all currently require manual support intervention. Design plan exists; estimated ~2–3 days to build.",
  },
  {
    title: "Terms & Conditions solicitor sign-off",
    severity: "medium",
    status: "pending",
    detail:
      "public/terms.html is a considered draft, not a solicitor-reviewed contract. Recommend UK consumer-law review before go-live, particularly §5 (Cancellation), §9 (Fair use and abuse), §10 (Refund policy and statutory cancellation rights), and the new §11 (Money-back guarantee) added in the 2026-08-05 launch-readiness audit.",
  },
];

function getLaunchReadinessItems() {
  return ITEMS;
}

module.exports = { getLaunchReadinessItems };
