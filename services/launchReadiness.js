// Source of truth for this list is docs/launch/KNOWN_ISSUES.md — this is
// a structured mirror of it for the admin panel, not a second, separately
// maintained list. Update both together when an item's status changes;
// see that file for the full explanation behind each entry.
//
// status values, matching KNOWN_ISSUES.md's taxonomy exactly — see
// computeReadinessSummary in database/adminMetrics.js for how these are
// interpreted: only "resolved" counts as fully closed.
//   resolved              — fixed and verified, including on production
//   resolved_staging_only — fixed and verified on staging; not yet true
//                           for production/customers
//   blocked               — cannot proceed without an external dependency
//                           (business decision or third-party approval)
//   deferred               — legitimately not started, not due yet
//   pending                — genuinely still open, no special category
const ITEMS = [
  {
    title: "Registered office address decision",
    severity: "blocker",
    status: "resolved",
    detail:
      "Resolved: 128 City Road, London, EC1V 2NX, United Kingdom (AFMD Ltd's registered office) is now stated in public/terms.html §1 and public/privacy.html §1. This unblocked the Twilio Address object item below.",
  },
  {
    title: "Twilio Address / Regulatory Bundle for UK number purchase",
    severity: "blocker",
    status: "blocked",
    detail:
      "Twilio's real purchase API requires both a registered Address object and an approved UK Regulatory Bundle for local numbers — confirmed via two separate real purchase-attempt rejections. Code-side, both are done and merged (TWILIO_ADDRESS_SID/TWILIO_BUNDLE_SID pass-through in services/twilioProvisioning.js). Neither variable is actually set anywhere (confirmed 2026-08-05) — the real Twilio Address object and an approved Bundle still need to be created/submitted with Twilio, whose own approval turnaround is outside this codebase's control.",
  },
  {
    title: "Migration 016/017 silent-revert regression",
    severity: "high",
    status: "resolved",
    detail:
      "Resolved and re-verified live 2026-08-05 against both staging (tigwgmayeuisrxjjykqd) and production (psbzynxplxfbyrbdidmn): the exact regression test that originally caught the 2026-07-22 silent revert (assign_household_twilio_number with a nonexistent household ID) now correctly raises its expected exception on both. See docs/engineering/016_017_migration_incident_notes.md for the incident history and docs/launch/KNOWN_ISSUES.md for the verification evidence.",
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
    status: "resolved_staging_only",
    detail:
      "The 'not yet built' status previously recorded here was wrong — the portal is fully implemented (routes/billing.js, routes/mobileApi.js, real stripe.billingPortal.sessions.create) and, as of 2026-08-05, live-tested successfully in Stripe test mode against a genuine staging customer. Recorded as staging-only because the full in-app round trip (tap through to the portal and back) hasn't been exercised yet, and live-mode Stripe Dashboard portal configuration hasn't been separately confirmed.",
  },
  {
    title: "Terms & Conditions solicitor sign-off",
    severity: "medium",
    status: "pending",
    detail:
      "public/terms.html is a considered draft, not a solicitor-reviewed contract. Recommend UK consumer-law review before go-live, particularly §5 (Cancellation), §9 (Fair use and abuse), §10 (Refund policy and statutory cancellation rights), and the new §11 (Money-back guarantee) added in the 2026-08-05 launch-readiness audit.",
  },
  {
    title: "Production email deliverability and sender configuration",
    severity: "blocker",
    status: "blocked",
    detail:
      "Corrected 2026-08-06 by checking the Supabase Dashboard directly (the 2026-08-05 DNS-only inference below was wrong): production (psbzynxplxfbyrbdidmn) already has custom SMTP enabled via Resend, sender Home Call Guard <support@mail.homecallguard.co.uk>, on a genuinely DKIM-verified sending subdomain. It was staging (tigwgmayeuisrxjjykqd) using the default mailer all along — confirmed via Supabase's own in-Dashboard warning there, matching every 'email rate limit exceeded' hit during this engagement's staging testing. Investigated whether the visible sender could instead be support@homecallguard.co.uk (the root domain): not possible without separately verifying the root domain in Resend, which would reintroduce exactly the reputation-mixing risk a subdomain avoids (confirmed via Resend's own documentation). Staging SMTP sender/host/port/username now entered (no-reply@mail.homecallguard.co.uk, smtp.resend.com, 465, resend) and all 5 Auth email templates redesigned with real branding and pasted into staging — blocked on the SMTP password/API key, which an AI assistant must never enter into any field per this engagement's safety rules; needs the account owner to complete that one field and click Save. No Reply-To field exists in Supabase's SMTP settings (checked directly). Real deliverability verification is blocked on the same password step. Production itself remains untouched throughout.",
  },
];

function getLaunchReadinessItems() {
  return ITEMS;
}

module.exports = { getLaunchReadinessItems };
