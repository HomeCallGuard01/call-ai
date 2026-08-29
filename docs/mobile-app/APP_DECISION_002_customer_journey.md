# APP_DECISION_002 — Customer Journey & UX Redesign

STATUS: Proposed for review. Not implemented.

## Design principle

The target customer is explicitly older, non-technical, or a family member setting this up *for* someone else. This is not a security-tool audience that wants configuration surface — it's an audience that wants to be told, in plain language, "you're protected" or "you're not, here's the one thing left to do." Every screen should answer one of three questions: **Am I protected? Who do I trust? Is anything wrong?** — nothing else competes for attention on the home screen.

## Do not recreate the website

`upload.html` today is a single scrolling page with a membership card, a checklist, a contacts list, and a call log stacked vertically — reasonable for a browser, wrong for an app. A true mobile experience means:

- **Tab-based navigation**, not scroll-everything: Home (status), Contacts, Activity, Account — four destinations, not one long page.
- **Status as the hero, not a card among cards.** The home screen's entire job is one clear state: a large, calm, unambiguous "Protected" / "Action needed" / "Setting up" indicator — closer to a smart-home security app's arm/disarm screen than a SaaS dashboard.
- **Progressive disclosure for setup**, not a checklist visible forever. Once activation is complete, the checklist should disappear entirely, not linger as a permanently-visible "0 of 5 done" list the way a web onboarding page tends to.

## Proposed screen set

1. **Home / Protection Status** — the hero state, a one-line explanation of what's currently happening (e.g. "3 unknown callers screened this week, all clear"), and the single next action if setup is incomplete.
2. **Trusted Contacts** — list + the one-button add flow (APP_DECISION_004). Editing/removing stays available but isn't the primary call to action once set up.
3. **Activity** — the call log, reframed as reassurance ("Your mum's number rang through normally," "An unknown caller was screened and didn't ask for anything suspicious") rather than a raw table of `ai_model`/`processing_time_ms`-style technical fields.
4. **Account** — membership status, manage-membership (hands off to Stripe's Billing Portal — a web view is genuinely fine here, this is a rarely-used, well-designed Stripe-hosted surface, not worth re-building natively), notification preferences, support contact.
5. **Onboarding/Activation** — see APP_DECISION_003, treated as its own first-class flow rather than a step inside account settings.

## Notifications

Two categories only, deliberately narrow to avoid alert fatigue for a security-anxious audience: **(a) a high-risk call was screened and blocked** (the moment that actually matters), and **(b) action needed on your account** (payment failed, setup incomplete). Do not notify on routine trusted-contact calls or successful low-risk screenings — silence is itself part of the reassurance design for this audience.

## Support

A single, obvious "Get help" entry point in Account, routing to a real human channel (phone/email — this audience does not want a chatbot). This is explicitly out of scope to build new backend for; it's a `mailto:`/`tel:` link plus whatever support channel already exists.
