Document: App Store / Google Play Store Listing Copy
Status: Draft — ready for review, not yet submitted anywhere.
Last Updated: 2026-08-22
Owner: Andrew Deane

---

# Store Listing Copy

Based on actual current app functionality (trusted-contact ring-through,
in-call scam screening, contact sync, call forwarding setup) — nothing
here describes a feature that doesn't exist yet.

## App Store Connect (iOS)

**App name**: Home Call Guard

**Subtitle** (30 char max): `Stop scam calls, not family`  (27 chars)

**Promotional text** (170 char max, can be updated without a new build):
> Home Call Guard screens unknown callers in real time and stops scams
> before they reach you — while friends and family always ring straight
> through.

**Description**:
> Home Call Guard protects your landline or mobile from scam calls —
> without changing your number or blocking anyone you actually want to
> hear from.
>
> HOW IT WORKS
> Forward your phone to Home Call Guard. Calls from the people you
> trust ring straight through immediately, exactly as before. Calls from
> anyone else are monitored in real time during the call itself — if it
> looks like a scam (a fake bank call, a "grandchild in trouble," a
> request to transfer money), the call is stopped before you're at risk.
>
> WHAT MAKES IT DIFFERENT
> • No upfront interrogation of every unknown caller — genuine callers
>   connect straight away.
> • Real-time protection during the call, not just number blocking.
> • Your trusted contacts are never screened, never delayed.
> • You keep your existing phone number.
>
> SYNC YOUR CONTACTS IN SECONDS
> One tap imports the contacts your phone allows Home Call Guard to see
> and saves them as trusted callers — no manual entry required. Sync
> again any time to pick up new contacts.
>
> BUILT FOR PEOPLE WHO'D RATHER NOT THINK ABOUT THIS
> Home Call Guard was built for families protecting a parent or
> grandparent from phone scams, and for anyone tired of screening their
> own calls. Set it up once; it works quietly in the background after
> that.
>
> Requires an active subscription. See homecallguard.co.uk for pricing.

**Keywords** (100 char max, comma-separated, no spaces):
`scam call blocker,call screening,elderly phone safety,fraud protection,caller id,phone scam`

**Support URL**: https://homecallguard.co.uk (or a dedicated /support page if preferred)
**Marketing URL**: https://homecallguard.co.uk
**Privacy Policy URL**: https://homecallguard.co.uk/privacy

**Category**: Primary — Utilities. Secondary — Lifestyle.

**Age rating**: 4+ (no objectionable content; standard questionnaire still needs completing in App Store Connect).

---

## Google Play Console (Android)

**App name**: Home Call Guard

**Short description** (80 char max):
> Real-time scam-call protection. Trusted contacts always ring through.

**Full description** (4000 char max) — same content as the iOS description above, Play allows plain text with line breaks, no character-count issue reusing it verbatim.

**Category**: Communication (or Tools)

**Contact email**: support@homecallguard.co.uk
**Privacy Policy URL**: https://homecallguard.co.uk/privacy

**Data safety section** (Play Console's own questionnaire — summary of what to declare, based on actual behaviour, not assumed):
- Contacts: collected (name + phone number only, for the contacts a customer explicitly syncs or adds), used for app functionality, not shared with third parties, user can request deletion.
- Personal info (email): collected for account creation, used for app functionality/account management.
- Financial info: handled entirely by Stripe (not stored by the app itself beyond a Stripe customer reference).
- Audio: call audio is processed in real time for scam detection during monitored calls only (never trusted-contact calls); not stored as raw audio beyond the active call — confirm exact retention against `services/liveMonitoring` behavior before finalizing this declaration precisely.

---

## Notes / open decisions for Andrew
- Subtitle/short-description wording above are drafts — adjust freely, no dependency on anything else.
- Confirm Play Store category preference (Communication vs Tools) — affects how the app is discovered.
- Age rating questionnaire in App Store Connect still needs to be completed manually (console-only action, not something I can do).
- Data safety section above is a starting draft — recommend a final pass against the exact current `services/liveMonitoring` audio-retention behavior before submitting, so the declaration is fully accurate.
