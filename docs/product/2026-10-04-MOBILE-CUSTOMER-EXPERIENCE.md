# Mobile customer experience — 1.0.2 (2026-10-04)

**Branch:** `feature/mobile-1.0.2-customer-experience`. Based on `integration/soft-launch-candidate-2026-10-04` at `7c39828`.
**Status:** source only. Nothing has been built, uploaded, submitted or deployed.

## 1. What the customer must be able to answer

| Question | Where it is answered (1.0.2) | Source of truth |
|---|---|---|
| Am I protected? | Home hero headline | `protection.fullyProtected` + `activationStage` (`services/lifecycle/activationState.js`) |
| Is setup complete? | Home "Your setup" checklist | `protection.protectionBlockers` (the 9 canonical gates) |
| Do I need to do anything? | Home: one action button under the headline | Same verdict, worded by `mobile/lib/protectionView.ts` |
| Who are my trusted contacts? | Home summary row → Contacts tab | `contacts` |
| What is my membership? | Home summary row → Membership tab | `membership` + `customerAllowance.membership` |
| How do I get help? | Help & Account tab → Help & support; "Contact support" actions on Home | — |

The app never defines "protected" itself. There is **one** decision point, `describeProtection()` in `mobile/lib/protectionView.ts`. It has no platform input, so iPhone and Android cannot disagree. A test asserts this.

## 2. App gap analysis

iOS and Android share one Expo codebase (`mobile/`). So "gaps" are platform branches, native configuration and store or billing facts. They are not separate apps.

### 2.1 Feature matrix (integrated candidate `7c39828`, before this branch)

| Area | Backend (integrated) | Android source | iOS source | Notes |
|---|---|---|---|---|
| Registration / signup | ✓ | ✓ | ✓ iPhone path (approved 2 Oct) | iOS records `device_type "mobile"` (approved decision; not redesigned) |
| Login / reset / confirm email | ✓ | ✓ | ✓ | shared |
| Onboarding device picker | ✓ | iPhone "Coming soon" + Android | iPhone only (2.3.10) | `lib/iphoneAvailability.ts` |
| Carrier compatibility gate | ✓ | ✓ | ✓ | server verdict |
| Subscription purchase | Stripe + RevenueCat webhooks | **Stripe Checkout in-app** | StoreKit via RevenueCat | Android: Play Payments policy risk (see §6) |
| Price display | `/billing/offer` | server Stripe offer | StoreKit `priceString` | no hard-coded amount on either platform |
| Restore purchases | — | n/a | ✓ | |
| Manage / cancel | Stripe portal | Stripe portal | Apple subscriptions deep link | |
| Payment-issue state | Stripe only | ✓ shown | **never shown**: Apple billing-retry and cancellation are not stored server-side | backend gap, see §6 |
| Trusted contacts (add / sync / edit / delete) | ✓ | ✓ | ✓ (Full and Limited access copy) | |
| HCG number provisioning | ✓ | ✓ (status only) | ✓ | sandbox purchases get no number (by design) |
| Call forwarding setup | MMI or Settings, per carrier | MMI auto-dial or Settings | `**21*` tel: link **unverified on iPhone** + manual hint; Settings copy rewritten for iOS | giffgaff/Three need the backend forwarding-number fix deployed |
| App registration for incoming calls | `/voice/registered` | FCM + Voice SDK | PushKit early init + CallKit | |
| Call readiness (permissions) | `/voice/device-readiness` | mic + POST_NOTIFICATIONS | mic (CallKit needs no notification permission) | |
| Locked-screen incoming call | — | **USE_FULL_SCREEN_INTENT blocked** (Play rejection of v10): heads-up banner can collapse after ~5–6 s on a locked phone | CallKit full-screen | tradeoff **not accepted** by Andrew; unchanged by this branch |
| Reachability / delivery health | evidence-based health | ✓ consumes | ✓ consumes | |
| **Canonical protection status** | ✓ `activationStage`, `protectionBlockers` | **ignored** | **ignored** | app used older booleans and its own six-state model |
| **Incident state** (forwarding ✓, app unregistered) | `awaiting_app` | **"Almost there… completes automatically"** | same | the September cancellation; **no action shown** |
| Hold / quarantine / old number | `on_hold` / `number_conflict` / stale evidence | not worded: fell through to "reconnecting"/"almost there" | same | |
| **Permanent HCG account number** | ✓ `account.accountNumber` | **not declared, not shown** | same | |
| Membership wording | `cancelled` = cancelling at period end | "Cancelling at period end" | same | |
| Allowance meter | ✓ | ✓ | ✓ | |
| Activity | ✓ | ✓ tab | ✓ tab | |
| Sign out (unregisters push first) | ✓ | ✓ | ✓ | |
| Delete account | ✓ | ✓ | ✓ (Apple manual cancellation note) | |
| Help / support / FAQ | — | ✓ | ✓ | |
| Privacy / terms | — | ✓ Legal | ✓ Legal | |

### 2.2 Android has, Apple lacks

- **Payment-issue visibility**, but only because Stripe reports it. Apple billing-retry and cancel-at-period-end are not stored (`services/allowance/entitlementState.js:25-28`). An iPhone subscriber shows **Active** until the period expires. This is backend work. It belongs to the RevenueCat webhook owner, not this branch.
- **Proven forwarding auto-dial**. On iPhone, whether iOS dials a `**21*…#` `tel:` link is unverified (`APP_DECISION_003` says yes, the 30 Sep parity note says no). The app already shows `IOS_MANUAL_DIAL_HINT`. This needs a TestFlight check.
- **Real-device evidence**. Android Build 19 ran on a Motorola. **No iOS build newer than Build 14 has ever run on an iPhone.**

### 2.3 Apple has, Android lacks

- **Restore purchases** and **store-sourced price** (StoreKit). Android uses the server's Stripe offer, which is equivalent.
- **Lock-screen full-screen call UI** (CallKit). Android's equivalent is blocked by the Play-policy permission removal. That tradeoff is not accepted, and Play Production is blocked on it.
- **Compliant in-app billing**. Android's in-app Stripe very likely breaches Google Play Payments policy. Play Billing (via the existing RevenueCat) is needed before **Production**. Internal testing is OK.

### 2.4 Missing from both, now fixed on this branch

1. Home ignored the canonical state, so it could not say *why* a customer wasn't protected, and it said nothing in the incident state. **Fixed.**
2. No setup progress on Home driven by server gates. **Fixed.** The old checklist is still behind "View protection status".
3. No HCG account number anywhere. **Fixed** (Membership, Help & Account).
4. Membership was buried (Account → Membership) and used inconsistent wording. **Fixed.** It is now a top-level tab, with shared wording.
5. Two server guidance keys (`calls_not_reaching_app`, `delivery_needs_attention`) were not declared in the mobile type. **Fixed.**
6. A server-protected phone with microphone/notifications denied still showed the green "You're protected" hero, with a banner above it. **Fixed.** It is now an attention state.

### 2.5 Missing from both, still open (not mobile-only work)

- An Apple cancellation / billing-retry state (backend RevenueCat webhook).
- Customer wording for `on_hold` is open decision **D-C5** (`docs/operations/CUSTOMER_LIFECYCLE_AUTOMATION.md`). This branch uses neutral copy: *"Protection on your account is paused. Please contact us…"*. It needs Andrew's sign-off.
- Reviewer and test accounts are not distinguishable in the app, by design (classification is admin-only). They follow the same evidence rules.

## 3. Information architecture

| Before (1.0.1 / candidate) | After (1.0.2 branch) |
|---|---|
| Tabs: Home · Contacts · Activity · Account | Tabs: **Home · Contacts · Membership · Help & Account** |
| Membership: Account → Membership | Membership: its own tab, also linked from Home and Account |
| Activity: tab | Activity: reached from Home "See all activity". The route is unchanged. |
| Account: Membership / Turn off / Support / Legal / Log out / Delete | Help & Account: status block (Membership, Protection, **HCG account**), Turn off, **Help & support**, Membership, **Privacy & terms**, Log out, Delete |

## 4. Home — before vs after

**Before.** Six local states (`setting_up`, `awaiting_confirmation`, `confirming_delivery`, `reconnect_needed`, `delivery_problem`, `protected`) were computed from four booleans plus a local "setup completed" flag. "Protected" required `fullyProtected`, which was correct. But the non-protected states were worded from local guesses. In particular, `awaiting_confirmation` ("Protection set up") was driven by a **local device flag**, and `confirming_delivery` covered the incident.

**After.** A brand header, then the shield hero, then **one upper-case headline**, one sentence, and at most one action:

| Tone | Headline | When (server `activationStage`, unless noted) | Action |
|---|---|---|---|
| protected (green shield) | **YOUR PHONE IS PROTECTED** | `fullyProtected` ∧ stage `protected` ∧ this phone can present calls ∧ no payment issue ∧ monitoring not switched off | none |
| setup (grey) | **FINISH SETTING UP PROTECTION** | `awaiting_forwarding`, `awaiting_number`, `awaiting_first_delivery`, `membership_upcoming`, `signed_up`/`membership_ended` (normally a 402 → same headline) | Turn on call forwarding / Check again / Start protection |
| attention (amber) | **PROTECTION NEEDS ATTENTION** | `awaiting_app`, `reconnect_needed` (**the incident**), `on_hold`, `number_conflict`, `number_failed`, old-number forwarding, permission denied, payment issue, recent failed delivery, monitoring off | Reconnect this phone / Open Settings / Update call forwarding / Contact support / Update payment |
| unknown (grey) | **WE CAN'T CONFIRM YOUR PROTECTION** | `ambiguous`, `unavailable`, `account_deleted`, any stage this app version doesn't know | Check again |

When not protected, the **setup checklist** follows:

```
✓ Membership active                              ← entitledNow ∧ notOnHold
✓ Your protected number is ready                 ← numberActive ∧ numberNotQuarantined
○ Call forwarding on                             ← forwardingVerifiedForCurrentNumber
○ This phone ready to receive protected calls    ← appReachable
○ First protected call received                  ← deliveryVerifiedForCurrentNumber
```

Every tick is a server gate. **When the server cannot establish state, it sends `protectionBlockers: ["stateKnown"]` only.** A naive "not in blockers = done" rule would then tick all five steps. The checklist renders every step as "Checking…" instead (tested).

Summary rows, Trusted contacts and Membership, link to their tabs. Stats, allowance and activity only show when the server says protected (activity also shows if there is any).

### 4.1 The September incident, specifically

A real customer paid, added contacts and forwarded calls. Nine calls reached HCG. The app never registered, none reached the customer, and they cancelled.

- **Before:** Home showed *"Almost there — Your call forwarding is set up correctly… completes automatically the next time a real call comes through."* No action.
- **After:** amber shield and **PROTECTION NEEDS ATTENTION**. *"Calls are reaching Home Call Guard, but this phone isn't connected to receive them. Reconnect now — until you do, protected calls can't reach you."* Then **[Reconnect this phone]**, with the checklist showing forwarding ✓, this phone ○, first call ○.
- **Reconnect this phone** clears only the app's local "already registered" flag and re-runs the **unchanged** registration path (`lib/voiceClient.ts`) for the same signed-in household. It never runs during an active call. It then re-reads the server verdict; success is decided by the server, not assumed.
- If microphone or notifications are off, the action is **Open Settings** instead. Re-registering cannot fix a phone that is unable to ring.

## 5. Membership

| Server state | Label |
|---|---|
| `active` | **Active** |
| `active` + `customerAllowance.membership.state = complimentary` | **Active — complimentary** ("No payment is taken for this membership.") |
| `trial` | **Free trial** (+ trial end date) |
| `payment_issue` | **Payment needs attention** (amber; button "Update payment details") |
| `cancelled` (= cancel at period end) | **Cancelled — protection continues until 28 October 2026** |
| 402 / no membership | **Protection unavailable** |
| `testPurchase` (App Store sandbox) | **Test purchase** ("Made with an App Store test account. No payment is taken.") |

**Price line.** This is the server's `membership.priceLabel`: the household's own Stripe price, or *"Billed monthly by Apple…"*. It is never written in the app. So the Membership tab will show **£5.99/month** automatically for a Stripe customer once the live Stripe Price changes, and can never disagree with the actual charge (see the price section of the release doc).

**HCG account.** It is shown as `HCG-00010017`-style (migration 062 format, `^HCG-[0-9]{8,}$`), with "Quote this if you contact us — it never changes." Anything else (routing number, UUID, malformed value) is never shown (tested). It is null until migration 062 is applied in production, and then the card simply doesn't render.

## 6. Customer states tested (Task 14)

`tests/mobile-protection-view.test.mjs` builds each state with the **real backend resolver** (`resolveCanonicalProtection` + `buildCustomerProtectionSteps`) and then words it through the mobile view model. It has 56 checks.

| # | State | Server stage | Headline / action |
|---|---|---|---|
| 1 | Paying, fully protected | `protected` | YOUR PHONE IS PROTECTED · none |
| 2 | Paying, app not registered (incident) | `awaiting_app` | NEEDS ATTENTION · Reconnect this phone |
| 2b | Delivered before, app now unreachable | `reconnect_needed` | NEEDS ATTENTION · Reconnect this phone |
| 2c | Delivery health UNREACHABLE | `reconnect_needed` | NEEDS ATTENTION · Reconnect this phone |
| 3 | Paying, forwarding incomplete | `awaiting_forwarding` | FINISH SETTING UP · Turn on call forwarding |
| 4 | Membership active, number not ready | `awaiting_number` | FINISH SETTING UP · Check again |
| 4b | Number provisioning failed | `number_failed` | NEEDS ATTENTION · Contact support |
| 5 | Payment issue | `protected` + `payment_issue` | NEEDS ATTENTION · Update payment |
| 6 | Cancelled, protected until end date | `protected` | YOUR PHONE IS PROTECTED; Membership "Cancelled — protection continues until …" |
| 7 | Financial hold | `on_hold` | NEEDS ATTENTION · Contact support (no finance wording) |
| 8 | Quarantined number | `number_conflict` | NEEDS ATTENTION · Contact support (no "quarantine") |
| 9 | Old-number mismatch | `awaiting_forwarding` + raw `activationVerifiedAt` | NEEDS ATTENTION · Update call forwarding |
| 10 | No entitlement | 402 (or `signed_up`/`membership_ended`) | FINISH SETTING UP · Start protection |
| 11 | Complimentary | `protected` | PROTECTED; Membership "Active — complimentary" |
| 12 | Sandbox Apple entitlement | `awaiting_number` + `testPurchase` | FINISH SETTING UP; "This is a test purchase…", no action |
| 13 | Reviewer/test account | same rules as any customer | e.g. FINISH SETTING UP before forwarding |
| — | State unreadable | `unavailable` | WE CAN'T CONFIRM · Check again; checklist shows nothing ticked |
| — | Permission denied on this phone | any | NEEDS ATTENTION · Open Settings |
| — | Monitoring off (allowance) | `protected` | NEEDS ATTENTION; "aren't being checked for scams right now" |
| — | Older backend (no stage) | — | previous model; the incident shape now resolves to attention |

**Parity.** `protectionView.ts` contains no `Platform`, `"ios"` or `"android"`. A test asserts it.

**Vocabulary.** No headline, body or action label in any of the states above contains Twilio, Supabase, OpenAI, quarantine, entitlement, Fortress, blocker, routing, UUID, provisioning, webhook, RevenueCat or Stripe. A test asserts it.

## 7. Branding (Task 13)

| Element | Finding | Action |
|---|---|---|
| App icon / Android adaptive icon | Real green shield on `#050a07`, consistent | none |
| Splash | `splash-shield.png` on `#050a07`; splash → window → first screen is one colour | none |
| Header | `BrandMark` lockup (shield + "Home Call **Guard**") on every main screen | none |
| Typography | System font (SF / Roboto); no custom font | none. The store frames use SF to match. |
| Colour | Single source `mobile/lib/theme.ts`; green = protected, amber = attention, grey = neutral. Never red, never frightening. | Amber is now also used for the hero ring and headline in attention states |
| Protection shield | Green rings only when the server says protected | Third, amber ring treatment for attention |
| Cards / buttons | Shared `Card`, `PrimaryButton`, `Banner` | New `ProtectionChecklist`; Home summary rows are tappable with chevrons |
| Empty states | Existing `EmptyState` | none |
| Store Frame 01 (1 Oct) | Shield point clipped flat by the old generator | New preview uses `shield-mark-from-logo-master.png` (full point) |

No new logo, colour or typeface has been introduced.

## 8. Accessibility

- Headline: `accessibilityRole="header"`. The hero shield is hidden from screen readers; it is decorative and the headline carries the meaning.
- Checklist: one accessible element per step, e.g. *"Call forwarding on: not done yet"*. The card label reads *"Setup progress: 2 of 5 steps complete"*.
- Summary rows: role button, with label *"Membership: Active"*.
- HCG account number: read digit by digit, and selectable for copying.
- Every touch target is at least 48 (`MIN_TOUCH_TARGET`). Colour is never the only signal: the headline text differs per state.

## 9. Not verified without a handset

These need a real device, with the TestFlight / Play internal build of this branch:

- "Reconnect this phone" re-registers and the server flips `appReachable`, on iOS (PushKit/CallKit) and Android (FCM).
- The hidden Activity route (`href: null`) behaves well, with no orphaned tab highlight, on both platforms.
- The tab label "Help & Account" fits at the largest Dynamic Type / font scale. If it doesn't, the fallback is "Account".
- The `**21*` tel: auto-dial on iPhone.
- The Android lock-screen behaviour (unchanged, still the open tradeoff).
