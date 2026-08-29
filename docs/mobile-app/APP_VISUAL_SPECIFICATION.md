# Home Call Guard Mobile App — Visual Specification

STATUS: Proposed for review. No code written. Documentation only, per instruction. Builds directly on the seven `APP_DECISION_00X` documents and `EXECUTIVE_SUMMARY.md` in this same folder — decisions already made there (tab structure, activation strategy, contact-picker approach, API surface) are referenced, not re-litigated.

**Market positioning (revised):** Home Call Guard appeals to three overlapping customer groups — (1) individuals roughly 25–55 protecting their own phone from scam calls, (2) adult children/relatives roughly 35–65 buying and managing protection for a parent or relative, and (3) older customers buying and using it themselves. The app must read as a **modern, premium, reassuring consumer security product** — closer in feel to a well-regarded banking or home-security app than to an assistive tool — while remaining extremely simple to use. Simplicity and clarity are pursued as universal design virtues that make the product better for everyone, not as visible accommodations for any one group; nothing in the navigation, copy, or visual language should signal "this was built for elderly users." Accessibility (font scaling, large touch targets, clear contrast, plain language, no unexplained jargon) is a baseline quality bar applied throughout — good practice for a 30-year-old glancing at the app between meetings just as much as for a 78-year-old using it directly.

Design voice throughout: **plain language, one idea per screen, generous whitespace, confident and calm rather than clinical.** Every screen should be understandable in seconds without needing to be read carefully, and should look like something a design-conscious adult would be comfortable being seen using — not a simplified or "senior mode" variant of a real product.

## Screen inventory

**A. First install & authentication** — A1 Splash, A2 Welcome/Value carousel, A3 Register, A4 Confirm-your-email, A5 Login, A6 Forgot password, A7 Reset password
**B. First-run setup (post-login, pre-protection)** — B1 Setup welcome, B2 Membership/subscribe, B3 Device & provider picker, B4 Activation instructions, B5 Activation verification, B6 Contacts intro, B7 Contact picker, B8 Contacts review, B9 Setup complete
**C. Daily use — main tabs** — C1 Home/Status, C2 Trusted Contacts list, C3 Add/edit contact, C4 Activity list, C5 Call detail, C6 Account
**D. Account sub-screens** — D1 Manage Membership, D2 Notification preferences, D3 Support/Help, D4 Legal (Terms/Privacy)
**E. System moments & edge states** — E1 Contacts permission priming, E2 Push permission priming, E3 Offline/network error, E4 Session expired

---

## A1 — Splash

**Purpose:** Bridge the gap between tapping the app icon and a usable screen; establish brand calm (not a loading spinner alone).
**Navigation:** Auto-advances — to A2 if no session exists, to C1 if a valid session is found (Supabase session restored from SecureStore).
**Layout:** Centred logo, brand background colour, no text.
**Controls:** None — not interactive.
**Customer journey:** Under one second on a warm start; this is purely a transition, never a screen the customer consciously waits on.
**Backend APIs used:** None directly — triggers the session-restore check (Supabase client, local token validation) that decides A2 vs. C1.
**Validation:** N/A.
**Edge cases:** Stored session exists but is expired/invalid → attempt silent refresh; if that fails, route to A5 (Login) rather than A2, since this is a returning customer, not a new one.

## A2 — Welcome / Value carousel

**Purpose:** Explain what the app does in the customer's own terms before asking for an account — reassurance first, commitment second.
**Navigation:** Swipeable, 3 panels max. "Get started" → A3. "Already have an account? Log in" (always visible, footer link, every panel) → A5.
**Layout:** Full-bleed illustration/icon per panel, one short headline, one sentence of supporting copy, dot pagination, primary button fixed at the bottom.
**Controls:** Swipe/next-arrow between panels, one primary CTA button, one secondary text link.
**Customer journey:** Panel 1 — "Stop scam callers before they reach you" (mirrors the homepage headline, already validated copy). Panel 2 — "Keep your number, keep your family's calls coming through exactly as normal." Panel 3 — "You stay in control — see exactly what was screened and why."
**Backend APIs used:** None.
**Validation:** N/A.
**Edge cases:** None — static content.

## A3 — Register

**Purpose:** Create the account.
**Navigation:** "Create account" → A4. Footer: "Already have an account? Log in" (always visible, per the established anti-enumeration design — never conditional) → A5.
**Layout:** Email field, password field (with show/hide), confirm-password field, single primary button. Consistent with the web register form's field set — no new fields introduced.
**Controls:** Two text inputs (email keyboard type for the first), one secure-text input with visibility toggle, one button (disabled until both password fields match and meet the 8-character minimum).
**Customer journey:** No mention of "confirmation email" until after submission — keeps the first screen simple.
**Backend APIs used:** Supabase Auth `signUp()` directly (same call the web `/register` route makes) — the app talks to Supabase Auth directly rather than proxying through a backend route, per APP_DECISION_005.
**Validation:** Client-side: valid email shape, password ≥8 characters, passwords match (mirrors the existing web validation exactly — same error copy: "Passwords do not match. Please try again."). Server-side (Supabase): duplicate/weak-password errors surfaced via the existing hedged wording pattern (see A3 edge cases).
**Edge cases:** Email already has a pending unconfirmed registration → same neutral, hedged copy as the web fix this engagement ("We've sent a confirmation email if this email address has a pending registration...") — critically, **the app must not re-implement the old signUp()-every-time bug**; it should call the same underlying Supabase behaviour the fixed web flow relies on. Email already fully registered and confirmed → route to A5 with the same neutral "may already be registered" wording, never a definitive "this email exists" claim.

## A4 — Confirm your email

**Purpose:** Tell the customer to check their inbox; this is the one unavoidable manual step in registration.
**Navigation:** No forward navigation — this screen waits. "Resend email" button. "I'll do this later" → A5 (Login) is available but not emphasised, since the app can't proceed to setup without a confirmed session anyway.
**Layout:** Large mail icon, one sentence ("We've sent a confirmation link to [email]"), spam-folder note, resend button, small "wrong email address? Start again" link back to A3.
**Controls:** One secondary "Resend confirmation email" button (rate-limited server-side already — surface a friendly cooldown message, not a raw error, if resent too soon).
**Customer journey:** The customer leaves the app to check email (deep link opens the app back to A5/C1 depending on session state after tapping the link) — this screen's job is to make that handoff feel expected, not like the app broke.
**Backend APIs used:** Supabase Auth `resend()` (same as the web `/resend-confirmation` route's underlying call).
**Validation:** N/A (no input on this screen).
**Edge cases:** Confirmation link opened on a different device than the one the app is installed on — the app should still work correctly on next login from the original device since confirmation state lives server-side, not locally.

## A5 — Login

**Purpose:** Authenticate a returning customer.
**Navigation:** "Log in" → C1 (if setup already complete) or B1 (if first login post-confirmation). "Forgot password?" → A6. "New here? Create an account" → A3.
**Layout:** Email field, password field with show/hide, single primary button, two footer links.
**Controls:** Two inputs, one button (disabled while empty), two text links.
**Customer journey:** Identical shape to the web login form — no reason to innovate here, this is a solved, familiar pattern.
**Backend APIs used:** Supabase Auth `signInWithPassword()` directly, then `GET /api/v1/me/dashboard` to determine whether this is a first-login (routes to B1) or returning customer (routes to C1) — mirroring the web's `ensureHouseholdAndRole` first-login bootstrap, which the app triggers by virtue of calling the same underlying auth flow.
**Validation:** Client-side: both fields non-empty. Server-side: "Incorrect email or password" (generic, matching the web's existing non-revealing copy), "Please confirm your email before logging in" with a resend option surfaced inline (mirrors the web's `unconfirmed` state).
**Edge cases:** Household bootstrap fails server-side (the same rare failure path the web's `setup_failed` error covers) → generic "We couldn't finish setting up your account, please try again or contact support" message, never a raw error.

## A6 — Forgot password

**Purpose:** Request a reset link.
**Navigation:** "Send reset link" → shows an inline confirmation state on the same screen (not a new screen) reading "If that email is registered, we've sent a reset link" — deliberately hedged, matching the web's existing non-enumerating copy. Back → A5.
**Layout:** One email field, one button, one back link.
**Controls:** One input, one button.
**Customer journey:** Minimal — this is a rarely-lingered-on screen by design.
**Backend APIs used:** Supabase Auth `resetPasswordForEmail()`.
**Validation:** Valid email shape only (never reveals whether the email exists).
**Edge cases:** None beyond the standard hedged response.

## A7 — Reset password

**Purpose:** Set a new password from the emailed recovery link.
**Navigation:** Opened via deep link (universal link on iOS / app link on Android) carrying the recovery token. "Set new password" → **directly to C1 or B1** (this is the screen where the household-bootstrap fix from this engagement matters most — the app must call the equivalent of `ensureHouseholdAndRole` here too, exactly as the fixed web `/reset-password-complete` now does, so a customer who resets their password before ever logging in doesn't hit the same session/household bug that was fixed on web).
**Layout:** New password field, confirm field, single button.
**Controls:** Two secure inputs with visibility toggles, one button.
**Customer journey:** Should feel like the natural continuation of A6, not a separate detour — "Password updated. You're signed in" on success (the corrected, accurate wording from the web fix — automatic sign-in only stated because it will now genuinely be true).
**Backend APIs used:** Supabase Auth session exchange from the recovery token, `updateUser()` for the new password, then the mobile equivalent of household-bootstrap-and-continue.
**Validation:** Password ≥8 characters, matches confirm field, "same password" rejection surfaced with the existing copy ("You have used this password already").
**Edge cases:** Expired/invalid recovery link (link opened too late, or already used) → "This reset link is invalid or has expired" with a route back to A6, matching the web's existing `showFatalError` behaviour exactly.

## B1 — Setup welcome

**Purpose:** The first thing a newly-confirmed customer sees — sets expectations for the short setup journey ahead (membership → activation → contacts) before diving in.
**Navigation:** "Let's get started" → B2 (or straight to B3 if already subscribed, e.g. a family member completing setup on someone else's already-paid account).
**Layout:** Short, warm headline ("Let's get you protected — this takes about 5 minutes"), a simple 3-step visual outline (Membership → Activate → Trusted contacts), single button.
**Controls:** One button.
**Customer journey:** This screen exists specifically to prevent the anxiety of an open-ended setup — telling the customer exactly how many steps remain and roughly how long it takes.
**Backend APIs used:** `GET /api/v1/me/dashboard` (checked on arrival to decide whether membership is already active, skipping to B3 if so).
**Validation:** N/A.
**Edge cases:** None.

## B2 — Membership / Subscribe

**Purpose:** Get the customer to an active paid membership before protection can begin.
**Navigation:** "Subscribe — £4.99/month" opens Stripe Checkout in an in-app browser (Expo `WebBrowser`, not a native re-implementation of Checkout — reuses the existing, already-built Stripe Checkout flow entirely). On return from Checkout → B3 (poll/reconcile via the existing `/billing/reconcile-session` fallback pattern already built for exactly this "webhook might not have landed yet" case).
**Layout:** Plain pricing card (price, what's included, cancel-anytime note — mirroring the existing pricing card copy already validated on the website), single CTA button.
**Controls:** One button (opens external browser flow).
**Customer journey:** Kept deliberately boring/familiar — Stripe's own Checkout UI is well-trusted and well-tested; no reason to obscure it behind a custom native payment UI for a v1.
**Backend APIs used:** `POST /billing/create-checkout-session` (reused as-is, per APP_DECISION_005), `GET /billing/reconcile-session` on return.
**Validation:** N/A (Stripe Checkout handles all payment validation).
**Edge cases:** Customer abandons Checkout (closes the in-app browser without completing) → return to B2, not an error state, with the button simply available to try again. Webhook delay on return → the reconcile-session fallback is what prevents a false "not subscribed" flash — same pattern already proven on web.

## B3 — Device & provider picker

**Purpose:** The first step of the activation flow (APP_DECISION_003) — determine exactly which instructions to show next.
**Navigation:** Select device type (iPhone/Android/Landline) → if Landline, select provider (BT/Sky/Virgin Media/TalkTalk/Plusnet/Other) → B4.
**Layout:** Large, tappable icon-cards for device type (not a dropdown — a visual, one-glance choice reads as more premium and is faster to scan than a menu, regardless of who's using it). Provider selection (landline only) as a simple list.
**Controls:** Icon-card selection (single-select), list selection (single-select), auto-advances on selection rather than requiring a separate "next" tap.
**Customer journey:** Two taps maximum to reach the right instructions — no customer should have to read instructions for a scenario that doesn't apply to them.
**Backend APIs used:** None (this is a local routing decision) — the selection may optionally be stored via `PUT` on the household record for support/analytics purposes, but nothing blocks on this.
**Validation:** N/A.
**Edge cases:** Customer unsure of their landline provider → an "I'm not sure" option routes to generic UK landline instructions (the universal `*21*` code) with a note that some providers need an extra step, rather than blocking progress.

## B4 — Activation instructions

**Purpose:** Show the exact forwarding code and explain, honestly, that this must be dialled manually — the core of APP_DECISION_003.
**Navigation:** "I've done this" → B5. "I need help" → D3 (Support).
**Layout:** The code itself, large, in a monospace-style tappable "copy" chip (copies to clipboard so the customer can paste it into their Phone app's dialler if that's easier than reading-and-typing). Plain numbered steps below (1. Open your Phone app 2. Dial this code 3. Come back here). Provider-specific caveat banner shown only when relevant (Sky/Virgin: "You'll need to call 150 first to add Call Divert to your account — this may cost around £2.50/month").
**Controls:** Copy-to-clipboard button, one primary "I've done this" button, one secondary help link.
**Customer journey:** Explicitly never implies the app can do this step for them — the copy is honest about the one manual step, framed as quick and simple rather than apologised for.
**Backend APIs used:** None directly on this screen.
**Validation:** N/A.
**Edge cases:** iPhone vs. Android vs. Landline all show the identical `*21*<number>#` format (per the research finding that these are largely unified) — only the Sky/Virgin landline caveat and the Virgin `*21*0<number>#` extra-zero format differ from the default.

## B5 — Activation verification

**Purpose:** Confirm the forwarding actually worked — the single highest-value screen in the whole activation flow (per APP_DECISION_003/007).
**Navigation:** Automatically polls after arrival; "Verified!" → B6. "Still checking..." (retry state) stays on this screen. "It's not working" → a troubleshooting panel (still B5, not a new screen) with the most common real causes (code mistyped, Sky/Virgin add-on not yet active, needs a moment to take effect) and a "try calling your own number from another phone" suggestion.
**Layout:** Large, calm status indicator (spinner → checkmark), one sentence per state, troubleshooting panel collapsed by default.
**Controls:** "Try again" button (re-triggers the check), "Contact support" link (only surfaced after a failed check, not pre-emptively).
**Customer journey:** This is the moment that replaces "did I do this right?" anxiety with a clear answer — treated as the emotional payoff of the whole setup flow, not a technical status check.
**Backend APIs used:** `POST /api/v1/activation/verify` — checks for a real routed test call in the `calls` table within a short window, per APP_DECISION_005/003.
**Validation:** N/A.
**Edge cases:** No test call detected within a reasonable window → troubleshooting panel, never a dead-end error. Customer's own outbound test call (calling their own forwarded number from another phone) is the recommended verification method in copy, since it's the most reliable way to actually generate a routed call without waiting for an unknown caller.

## B6 — Contacts intro

**Purpose:** Frame why trusted contacts matter before asking for the contacts permission (soft-ask pattern, see E1).
**Navigation:** "Add trusted contacts" → E1 (permission priming) → then B7.
**Layout:** Short explanation ("Family and friends on this list always ring straight through — no screening, no delay"), single button.
**Controls:** One button, one "Skip for now" text link (protection still activates with zero contacts — an empty trusted list is a valid, if less useful, state, not a blocker).
**Customer journey:** Establishes the mental model (trusted vs. unknown) before the mechanical task of selecting people.
**Backend APIs used:** None.
**Validation:** N/A.
**Edge cases:** "Skip for now" path still lands the customer in B9 (Setup complete) — trusted contacts is not a hard gate on activation.

## B7 — Contact picker

**Purpose:** The core "tap → select" native contact-selection experience (APP_DECISION_004).
**Navigation:** Multi-select from the device address book → "Add N contacts" → B8.
**Layout:** Searchable list of device contacts (name + number), checkbox-style multi-select, running counter of selected contacts, sticky "Add N contacts" button at the bottom.
**Controls:** Search field, per-row checkbox/tap-to-select, primary button (shows live count, disabled at zero selected).
**Customer journey:** Built in-app rather than using the OS's native picker UI (per APP_DECISION_004's reasoning — native pickers are single-select-oriented on both platforms), so this is a genuinely custom screen, not a system sheet.
**Backend APIs used:** None yet — this screen only reads the local device address book via the granted permission; nothing is sent to the server until B8's confirmation.
**Validation:** Contacts without any phone number are filtered out of the list entirely (nothing useful to select). UK number normalisation happens client-side for display (matching the existing `normaliseNumber` logic) but the authoritative check is server-side on submission.
**Edge cases:** Zero contacts on the device at all → empty state directing to B9 with contacts skipped, not an error. Permission denied at the OS level → route to E1's denied-state messaging with a path to system Settings, not a dead end.

## B8 — Contacts review

**Purpose:** One last confirmation before the selected contacts are sent to the server — a deliberate pause, not friction for its own sake, given this is sending personal data off-device.
**Navigation:** "Confirm and add" → `POST /api/v1/contacts/bulk` → B9. "Back" → B7 (selection preserved).
**Layout:** Simple list of the selected names/numbers, edit (remove) affordance per row, single confirm button.
**Controls:** Remove-icon per row, one primary button.
**Customer journey:** Reinforces the privacy story from APP_DECISION_004 — only these specific people, nothing else from the address book, are about to be sent.
**Backend APIs used:** `POST /api/v1/contacts/bulk`.
**Validation:** Server-side duplicate prevention (existing `database/contacts.js` logic, reused as-is) — duplicates within the household are silently skipped, not shown as an error, since the customer didn't do anything wrong by selecting an already-trusted contact.
**Edge cases:** Network failure mid-submission → clear retry affordance, selection state preserved (never silently lose the customer's picks).

## B9 — Setup complete

**Purpose:** A genuine, unhurried celebration moment — the payoff for completing membership, activation, and contacts.
**Navigation:** "Go to my dashboard" → C1.
**Layout:** Large positive status graphic/animation, one confirming sentence ("You're protected — Home Call Guard is now screening unknown callers"), single button.
**Controls:** One button.
**Customer journey:** This is the emotional high point of onboarding — deliberately unhurried, not squeezed between two other screens, regardless of who's setting it up.
**Backend APIs used:** `GET /api/v1/me/dashboard` (pre-fetched for a fast C1 landing).
**Validation:** N/A.
**Edge cases:** Reached via "Skip for now" contacts path → copy adjusts slightly ("You're protected — add trusted contacts any time from the Contacts tab") rather than presenting an identical, now-inaccurate message.

## C1 — Home / Protection Status

**Purpose:** The hero screen and default landing tab — answers "Am I protected?" at a glance, per APP_DECISION_002.
**Navigation:** Bottom tab bar (persistent): Home (this screen) / Contacts / Activity / Account. No further drill-down from the status indicator itself.
**Layout:** Single large status state (Protected / Action needed / Setting up) filling the upper portion of the screen, a one-line human-readable summary beneath it ("3 unknown callers screened this week, all clear"), and — only if setup is incomplete — a single "finish setup" card linking back into the relevant B-flow screen.
**Controls:** One conditional CTA card (setup-incomplete state only); otherwise no controls beyond the tab bar.
**Customer journey:** Once setup is complete, this screen should be almost entirely passive reassurance — nothing to tap, nothing to configure, by design.
**Backend APIs used:** `GET /api/v1/me/dashboard`.
**Validation:** N/A.
**Edge cases:** Membership lapsed/payment failed → status state becomes "Action needed" with a direct link to D1 (Manage Membership), using the same real, server-derived membership state established this engagement (never a client-guessed status). Activation not yet verified → "Setting up" state links back to B5.

## C2 — Trusted Contacts list

**Purpose:** View and manage who rings straight through.
**Navigation:** "+" → C3 (add). Tap a contact → C3 (edit mode, pre-filled). Swipe-to-delete or an explicit delete affordance per row.
**Layout:** Simple list, name + number per row, "+" floating action button or header button, empty state if no contacts exist yet.
**Controls:** List rows (tappable), delete affordance (with confirmation), "+" button. A secondary "Add from contacts" entry point re-enters the B7 picker flow for adding more contacts later, not just during onboarding.
**Customer journey:** This screen should feel identical in spirit to B7/B8 when adding more contacts later — the same picker and review pattern is reused, not a second, different "add contact" mechanism.
**Backend APIs used:** `GET /api/v1/me/dashboard` (contacts are part of the same aggregate payload) or a dedicated contacts-list read if the aggregate proves too heavy in practice; `DELETE /contacts/:id` (existing endpoint, reused as-is).
**Validation:** Delete requires an explicit confirmation step (matching the existing web "confirm() prompt still guards every delete" behaviour).
**Edge cases:** Empty state — reassuring, not alarming ("No trusted contacts yet — add the people you don't want screened"), with a clear path into the picker, not a warning.

## C3 — Add/edit contact (manual)

**Purpose:** Manual single-contact entry/edit — for the customer without the person in their device address book, or fixing a typo.
**Navigation:** Save → back to C2. Cancel → back to C2, no change.
**Layout:** Name field, phone number field, single save button. Delete button present only in edit mode.
**Controls:** Two text inputs, one primary button, one destructive button (edit mode only, with confirmation).
**Customer journey:** Kept deliberately simple and secondary to the contact-picker flow — this exists for completeness (landline-only households without a synced digital contact list are an explicitly known real customer scenario from this engagement), not as the primary path.
**Backend APIs used:** `POST /contacts` (add), `PUT /contacts/:id` (edit) — both existing endpoints, reused as-is.
**Validation:** Name required, phone number required and normalised/validated (existing `normaliseNumber` logic), duplicate-within-household check surfaced as a friendly inline message, not a generic error.
**Edge cases:** Editing a contact to a number that duplicates another existing contact → same friendly duplicate messaging as the add path.

## C4 — Activity list

**Purpose:** The call log, reframed as reassurance rather than a raw technical table (per APP_DECISION_002).
**Navigation:** Tap a row → C5 (call detail). Pull-to-refresh.
**Layout:** Reverse-chronological list, each row showing: caller (trusted contact name, or "Unknown caller"), outcome in plain language ("Rang straight through" / "Screened, no concerns" / "Screened — high risk, call ended"), timestamp. Colour/icon coding by outcome severity (trusted = neutral, low-risk-screened = neutral/positive, high-risk = a clear warning colour) — semantic colour, not the app's accent colour, per the design-system principle of keeping status colour distinct from brand colour.
**Controls:** List rows (tappable), pull-to-refresh.
**Customer journey:** This is where the product's actual value becomes visible and tangible — the copy should make it obvious the app is actively working, even on quiet weeks with no high-risk calls.
**Backend APIs used:** `GET /api/v1/me/dashboard` (or a paginated dedicated activity endpoint if the list grows long enough to need pagination — a reasonable Phase-2-time decision, not fixed here).
**Validation:** N/A (read-only screen).
**Edge cases:** Empty state ("No calls yet — we'll let you know as soon as we screen one") rather than a blank list. Very long history → pagination/infinite-scroll rather than loading everything at once.

## C5 — Call detail

**Purpose:** Drill-down into a single call's outcome for the customer who wants to understand why something was flagged (or wasn't).
**Navigation:** Back → C4.
**Layout:** Caller number (and name, if trusted), timestamp, outcome, and — for screened calls — a short, plain-language reason ("This caller asked for a one-time passcode, which is a common scam tactic" rather than exposing raw model output or technical fields).
**Controls:** None beyond back navigation.
**Customer journey:** This is where trust in the AI's judgement is built or lost — the reasoning shown must be genuinely accurate to what happened, in the customer's own language, never a raw technical trace.
**Backend APIs used:** Part of the same activity payload as C4 — no separate endpoint needed unless call detail proves too heavy to include in the list response.
**Validation:** N/A.
**Edge cases:** A call where the AI's classification was uncertain/borderline should say so honestly ("This call seemed unusual, so we were cautious") rather than presenting false confidence either way.

## C6 — Account

**Purpose:** The hub for membership, settings, and support — everything that isn't daily protection status.
**Navigation:** Rows for: Membership (→ D1), Notifications (→ D2), Support (→ D3), Legal (→ D4), Log out (confirmation, then → A5).
**Layout:** Simple grouped list of rows, each with a label and a chevron, standard iOS/Android settings-screen conventions (this is the one screen where following platform-native settings-list patterns exactly is the right call, not a bespoke design).
**Controls:** List rows (navigate), log-out row (destructive-style, with confirmation).
**Customer journey:** Deliberately unremarkable — this screen's job is to be instantly familiar, not distinctive.
**Backend APIs used:** `GET /api/v1/me/dashboard` for the membership summary shown at the top of this screen.
**Validation:** N/A.
**Edge cases:** None beyond the log-out confirmation.

## D1 — Manage Membership

**Purpose:** View real membership status and hand off to Stripe's Billing Portal for any change (cancel, update payment method, view invoices).
**Navigation:** "Manage membership" opens the Billing Portal in an in-app browser (Expo `WebBrowser`) — not a native re-implementation, per APP_DECISION_001/005. Back → C6.
**Layout:** Plan name, price, status (Active/Trial/Cancelled-at-period-end/Payment issue — all real, server-derived states, matching the web membership card built this engagement), next billing date, single "Manage membership" button.
**Controls:** One button (external browser handoff).
**Customer journey:** Matches the real, already-implemented web Membership card's honesty principle exactly — never a client-side-guessed status, always what the server actually knows.
**Backend APIs used:** `GET /api/v1/me/dashboard` for status display, `POST /billing/manage-membership` for the Portal session (existing endpoint, reused as-is).
**Validation:** N/A.
**Edge cases:** Payment failed / grace period → the exact real state and date, never an invented one (matching this engagement's explicit "do not invent dates" principle from the Stage 4 launch-readiness work).

## D2 — Notification preferences

**Purpose:** The two-category toggle from APP_DECISION_002 — deliberately narrow.
**Navigation:** Back → C6.
**Layout:** Two toggle rows only: "High-risk call alerts" and "Account alerts" (payment issues, setup reminders) — both on by default, no granular per-event configuration offered, matching the deliberate narrowness of the notification design decision.
**Controls:** Two toggles.
**Customer journey:** Simplicity is the point here — no customer should need to think hard about notification settings; two clearly-named toggles beat a granular preferences screen for everyone, not just for a less technical user.
**Backend APIs used:** `GET`/`PUT /api/v1/notifications/preferences`.
**Validation:** N/A.
**Edge cases:** Push permission was denied at the OS level → both toggles shown but disabled, with a note directing to system Settings, rather than a toggle that silently does nothing.

## D3 — Support / Help

**Purpose:** A single, obvious route to a real human. This is a trust product dealing with genuine anxiety (scam calls, family safety) — a bot-first support experience undermines that trust regardless of who's asking, so a direct human channel is the right call across all three customer groups, not an accommodation for any one of them.
**Navigation:** Back → C6 (or wherever D3 was entered from, e.g. B4's "I need help" link).
**Layout:** Phone number and email, both as large, directly tappable rows (`tel:`/`mailto:`), plus a short FAQ list for the most common activation questions.
**Controls:** Two tappable contact rows, expandable FAQ rows.
**Customer journey:** No forms, no ticket numbers, no "chat with our bot" — a direct human channel, reachable in one tap.
**Backend APIs used:** None.
**Validation:** N/A.
**Edge cases:** None.

## D4 — Legal (Terms/Privacy)

**Purpose:** Link out to the existing, already-maintained terms.html/privacy.html.
**Navigation:** Opens in an in-app browser. Back → C6.
**Layout:** Two simple rows.
**Controls:** Two tappable rows.
**Customer journey:** Not a screen customers linger on; correctness and easy access matter more than design here.
**Backend APIs used:** None (links to existing static web pages).
**Validation:** N/A.
**Edge cases:** None.

## E1 — Contacts permission priming

**Purpose:** A soft-ask screen shown *before* the OS's hard permission dialog, explaining why access is needed — improves grant rates and is standard best practice for a permission this central to the app's core feature.
**Navigation:** "Allow access" → triggers the real OS permission dialog → B7 on grant. "Not now" → back to B6 with contacts skipped.
**Layout:** Short explanation of exactly what will and won't happen ("We'll show you your contacts so you can choose who to trust — we never see or store anyone you don't select"), single button.
**Controls:** One button, one "Not now" text link.
**Customer journey:** This is the screen doing the most privacy-reassurance work in the whole app — the copy must be scrupulously accurate to the real implementation (APP_DECISION_004), since overpromising here would be a genuine trust failure if discovered later.
**Backend APIs used:** None.
**Validation:** N/A.
**Edge cases:** OS-level permission previously denied (customer needs to go to system Settings to change it) → detected via the OS permission-status API and shown a direct "Open Settings" link rather than re-showing a priming screen that can't actually trigger the dialog again.

## E2 — Push permission priming

**Purpose:** Same pattern as E1, for push notifications — shown once, at a sensible moment (after B9, not immediately on first launch, so the ask has context).
**Navigation:** "Allow notifications" → OS dialog → registers the device token via `POST /api/v1/devices/register` on grant. "Not now" → proceeds without push, revisitable later from D2.
**Layout:** Short explanation ("We'll let you know if we ever block a high-risk caller"), single button.
**Controls:** One button, one "Not now" link.
**Customer journey:** Framed around the one notification category that actually matters (high-risk-call alerts), not a generic "enable notifications" ask.
**Backend APIs used:** `POST /api/v1/devices/register` (only called after a real grant).
**Validation:** N/A.
**Edge cases:** Denied → D2's toggles reflect the disabled state (see D2 edge case).

## E3 — Offline / network error

**Purpose:** A consistent, calm treatment for any screen that can't reach the backend — not a separate screen so much as a shared banner/state pattern applied across C1/C2/C4/D1.
**Navigation:** N/A — an overlay/banner state on the current screen, not a navigation destination.
**Layout:** A slim top banner ("You're offline — showing your last known status") on any data screen when a fetch fails, rather than a blank error page.
**Controls:** Implicit retry on next pull-to-refresh or app foreground.
**Customer journey:** "Can't reach the server" must never look like "something is wrong with your protection" for any customer — the banner explicitly separates connectivity from protection status, since conflating the two would undermine trust in a security product regardless of who's using it.
**Backend APIs used:** N/A (this is the failure-handling pattern for every API call above).
**Validation:** N/A.
**Edge cases:** Genuinely stale data (last successful fetch was a long time ago) → the banner's copy should reflect that ("Last updated 2 days ago") rather than implying real-time freshness it can't guarantee.

## E4 — Session expired

**Purpose:** Handle a refresh-token failure gracefully (matching the existing web `requireAuth`'s refresh-then-clear-and-redirect logic, adapted for mobile's bearer-token model).
**Navigation:** Automatic → A5 (Login), with a brief explanatory message, not a silent bounce.
**Layout:** A short interstitial ("Please log in again to continue") before landing on A5.
**Controls:** None (auto-transitions).
**Customer journey:** Should be rare (refresh tokens are long-lived) — when it happens, it must not feel like data was lost; re-authenticating should return the customer to exactly where they were, not force them back through onboarding.
**Backend APIs used:** The mobile equivalent of `requireAuthApi`'s refresh-then-fail logic (APP_DECISION_005).
**Validation:** N/A.
**Edge cases:** None beyond returning to the correct post-login destination (C1, not B1, for a customer who already completed setup).

---

## Summary count

**28 screens/states** across 5 groups (7 auth, 9 first-run setup, 6 daily-use tabs, 4 account sub-screens, 4 system/edge states) — every screen traced back to a decision already made in `APP_DECISION_001` through `APP_DECISION_007`, with no new architectural decisions introduced here. Ready for your review before Phase 2 implementation begins.
