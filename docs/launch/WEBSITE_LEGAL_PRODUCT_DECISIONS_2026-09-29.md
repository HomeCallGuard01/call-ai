# Website / Terms / Privacy — decisions for Andrew (2026-09-29)

Branch `website/launch-ready-homepage`. Nothing here is deployed. Everything below
was traced from code on `origin/main` (eb43368, which GitHub deployment records show
live in production since 2026-09-27 14:12 UTC), not assumed.

Already applied on the branch (plain product-fact corrections, no change to
obligations): Terms §2 "UK home telephone numbers" → "UK mobile phone numbers" and
app-managed account; §5 "Manage membership" in the app; §6 Activity list; §9 "one home
telephone line" → "one mobile phone number" per subscription; Terms date and
`TERMS_VERSION` → 2026-09-29. **Set both to the real publication date at deploy.**

The items below change what HCG promises, discloses or is liable for, so they are
**proposed only**.

---

## A. Terms — proposed BEFORE → AFTER

### T1 §2 — announcement to callers (factual, but a customer-facing promise)
Code: `server.js` `/voice` plays *"This number is monitored and protected by Home Call
Guard."* to every monitored caller before the phone rings.

- BEFORE: "…monitored by our automated system for the duration of the call for signs of
  a scam or nuisance call — the Service does not block or delay a call before it reaches
  your phone."
- AFTER: "…monitored by our automated system for the duration of the call for signs of
  a scam. Before the call rings through, the caller hears a short message that your
  number is protected by Home Call Guard; the Service does not otherwise block or hold
  the call before it reaches your phone."

### T2 §2/§7/§12 — "nuisance" calls (scope)
The monitor detects scam signals only (`services/liveMonitoring` taxonomy). There is no
nuisance/marketing-call detection.
- Proposal: drop "or nuisance" in §2 and §7 ("likely scam calls", "every scam call").
  In §12, keep "scam, nuisance or fraudulent call" as-is. It is a liability exclusion,
  and a broader exclusion protects HCG.

### T3 §7 — unsubstantiated efficacy claim
- BEFORE: "This significantly reduces your exposure to unwanted calls, but it is not a
  guarantee."
- AFTER: "It is designed to reduce your exposure to scam calls, but it is not a
  guarantee."

### T4 §4 — when protection starts (affects §10's 14-day wording)
Code: payment creates the entitlement. A number is then assigned, and protection only
works once the customer dials the forwarding code (app step "Turn on call forwarding").
So protection does not start "within a few seconds of completing checkout".
- BEFORE: "Your protection is activated as soon as your payment is successfully
  processed and confirmed — typically within a few seconds of completing checkout. Your
  dashboard will show your live protection status, and we will let you know if
  activation is taking longer than expected."
- AFTER: "Your subscription starts as soon as your payment is confirmed. Call
  protection starts once setup is complete, including the one-time call-forwarding step
  on your phone, which the app guides you through. The app shows your live protection
  status, and we will let you know if setup is taking longer than expected."
- Decision: §10 says a proportionate deduction may apply if the customer asks us to
  "begin providing the Service (activate your protection)" within 14 days. Confirm which
  event that means: payment, or completed setup.

### T5 §3/§5 — payment failure (Terms are silent)
Code: Stripe retries a failed renewal. Access continues while the subscription is
`past_due` and ends when Stripe cancels it or marks it unpaid. The dashboard shows
"Update payment details".
- Proposed new §3 paragraph: "If a monthly payment fails, we (through our payment
  processor) will retry it and let you know so you can update your payment details.
  Your protection continues while payment is being retried. If payment still can't be
  taken, your subscription will end and protection will stop."
- Decision: the retry window is set in Stripe (dashboard setting, not in code). Confirm
  it before stating a number of days.

### T6 §5 — cancel ≠ turning off forwarding (customer-harm risk)
Code: after cancellation plus a grace period (`markPendingRelease` →
`releaseExpiredTwilioNumber` → `quarantineHouseholdTwilioNumber`), the number is no longer linked to the household. Calls still
forwarded to it hear "We're sorry, this call cannot be connected right now." The web
dashboard warns about this; the Terms and homepage don't.
- Proposed §5 addition: "Cancelling does not switch off call forwarding on your phone.
  When your protection ends, turn call forwarding off (the app shows you how, under
  Account → "Need to turn protection off?"), or calls to your number may not reach you."

### T7 §2/§8 — calls are delivered through the app
Code: calls are delivered to the app (`dialHouseholdOrFailClosed`, client-only mode).
With no registered app, the caller hears "this call cannot be connected right now".
- Proposed §8 addition: "Calls are delivered to you through the Home Call Guard app, so
  it needs to stay installed and signed in on the protected phone, with an internet
  connection."

### T8 §3/§5 — Apple billing (only when iPhone launches)
iOS uses Apple in-app purchase via RevenueCat (`mobile/lib/purchases.ts`). Only Apple
can cancel or refund it. This isn't needed while iPhone is "Coming soon", but it is a
**launch prerequisite for iPhone**: "If you subscribe through the App Store, Apple
takes payment and you manage or cancel the subscription in your Apple account settings;
Apple's own terms apply to that payment."

---

## B. Privacy — what the system actually does

| Stage | What happens | Where it's stored |
|---|---|---|
| Audio recording | None. No `<Record>` or record options anywhere. | Nothing |
| Transcription | Calls from non-trusted numbers: Twilio Media Stream audio is buffered **in memory** and sent to OpenAI `whisper-1` (`transcribeChunk.js`). The previous window's text goes back as a prompt. | Not on disk |
| Transcript storage | None. The `calls` row keeps signal/category IDs only (`decision_reason`, `termination_reason`), plus score, outcome, duration and the caller's number. | `calls` (Supabase) |
| Transcript logging | Stopped by bff819e (in eb43368, **live since 2026-09-27**). Only length/diagnostics are logged now. **Before that, transcript text was written to Railway logs.** | Railway log retention |
| Risk decision | HCG's own rules (`riskMonitor.js`, scoring taxonomy). No LLM in the live path. | — |
| Legacy AI path | `/process` → gpt-4o-mini. Unreachable for real calls since the pre-call screening removal (late Aug 2026), but publicly POSTable. Fix: branch `fix/process-endpoint-webhook-auth` (e2895f1, not deployed). Before late Aug, caller speech excerpts went to gpt-4o-mini. | Old `calls` rows have `ai_model` |
| Customer SMS | Fixed-text warnings to the customer's own number (`smsWarning.js`). **Not mentioned anywhere in the Privacy Policy or on the site.** | Telephony provider's message logs |
| Provider-side retention | OpenAI API retention and telephony provider call/SMS logs follow their own terms. Not verifiable from code. | Providers |

### P1 — transcript sentence (keep the strong promise, make it exactly true)
- BEFORE: "We do not store the call audio or a transcript of what was said; only the
  short summary described above is kept."
- AFTER: "We do not record calls. Call audio is processed in memory while the call is
  happening and is never saved, and we do not keep a transcript of what was said, only
  the short summary described above. Our transcription provider processes the audio
  under its own terms, which may allow it to keep data for a limited period, for example
  to monitor for abuse."
- **Decision (P1a):** transcript text written to Railway logs before 2026-09-27 12:00
  UTC. Check the Railway plan's log retention (this may already have expired), and
  decide whether an internal privacy-incident assessment is needed. Not a website
  change.

### P2 — SMS warnings (disclosure missing)
- Proposed addition to "How we use your information": "to send a text message to your
  protected number if a call shows signs of a scam, or when monitoring of a very long
  call ends".
- Decision: confirm SMS sending is actually enabled in production (it depends on the
  configured sender number).

### P3 — AI processing
No change needed for the current live path. "Our own automated checks and a
third-party transcription service" is accurate. If `/process` (gpt-4o-mini) is ever
re-enabled, the Policy must add an AI-classification processor first.

### P4 — factual wording
- "linked to the household phone number the Service protects" → "linked to the phone
  number the Service protects".
- Privacy "Last updated: 25 August 2026", but `PRIVACY_VERSION` = 2026-09-13 (already
  inconsistent). Align them on the next Privacy publication.

---

## C. Trusted-contact and account deletion — traced

- **Delete one contact** (app or web): the row is deleted (`database/contacts.js`
  `deleteContact`, scoped by household).
- **Sync from phone**: add-only by design. A contact removed from the phone stays in HCG
  until deleted in the app.
- **Account deletion** (app: Account → Delete Account → `DELETE /api/v1/me/account`):
  1. Cancels a Stripe subscription, and fails closed if that fails.
  2. Releases the number.
  3. Runs `anonymize_inactive_household`, which since **migration 029** deletes all
     `contacts` and `calls` rows and scrubs the household's email, phone and Stripe ID.
  4. Deletes the login.

  029 records itself as applied in production on 2026-08-25. An earlier note (22 Sep)
  that "contacts survive deletion" missed 029. To confirm read-only: `select
  pg_get_functiondef('public.anonymize_inactive_household(uuid,text)'::regprocedure);`
  should contain `delete from public.contacts`.
- **Survives deletion**:
  - Anonymised `households` row (device/carrier/app-version fields, no contact details).
  - `subscriptions`/`entitlements`.
  - `terms_acceptances`, `acquisition_events`, voice-registration history (household_id
    only).
  - **`stripe_webhook_events.payload`**: the full Stripe event JSON, which can include
    the customer's email and name.
  - The Stripe customer record at Stripe.
  - Telephony and transcription provider logs.
  - Pre-2026-09-27 Railway logs (full customer mobile numbers and transcripts).

**Decisions:**
- **C1.** Redact personal fields from `stripe_webhook_events.payload` after processing
  (or on deletion), or keep them as billing records.
- **C2.** Every contact route (list/add/edit/delete/sync) requires an active
  subscription, so a lapsed customer can't delete a single contact (only the whole
  account). Allow delete without entitlement?
- **C3.** Data for cancelled-but-not-deleted accounts is kept indefinitely ("lifetime of
  your account"). Set an inactivity retention period?

Applied on the branch: `delete-account.html` now documents the in-app route. It
previously listed email only, while the app offers immediate deletion.

---

## D. Other

- **Mobile app** still says "Landline — Coming soon" (`mobile/lib/landlineAvailability.ts`
  `LANDLINE_CARD_LABEL_COMING_SOON` / `LANDLINE_COMING_SOON_TITLE`). This ships from the
  mobile release branches (RC freeze), so it isn't changed here. Change it in the next
  app build.
- **Checkout**: Android uses **Stripe Checkout in an in-app browser**, not Google Play
  Billing. Management goes through the Stripe Billing Portal. This is the known Play
  Payments policy risk (see existing memory/issue). The Terms describe a payment
  processor generically, which is accurate for Stripe.
- **Attribution**: prototype on `feature/play-install-referrer-attribution` (0a8c952).
  Linking a sign-up to a paid customer needs a schema decision: store UTM on the
  household at first login.
