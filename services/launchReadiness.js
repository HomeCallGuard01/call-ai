// Source of truth for this list is docs/launch/KNOWN_ISSUES.md — this is
// a structured mirror of it for the admin panel, not a second, separately
// maintained list. Update both together when an item's status changes;
// see that file for the full explanation behind each entry.
const ITEMS = [
  {
    title: "Registered office address decision",
    severity: "blocker",
    status: "pending",
    detail:
      "public/terms.html §1 still has a placeholder. This same address is required for the Twilio Address object needed to purchase UK numbers — resolving this one decision unblocks both.",
  },
  {
    title: "Twilio Address object for UK number purchase",
    severity: "blocker",
    status: "pending",
    detail:
      "Twilio's real purchase API rejected a test attempt: an AddressSid is required for UK local numbers. Blocked on the registered office address decision above.",
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
      "public/terms.html is a considered draft, not a solicitor-reviewed contract. Recommend UK consumer-law review before go-live.",
  },
];

function getLaunchReadinessItems() {
  return ITEMS;
}

module.exports = { getLaunchReadinessItems };
