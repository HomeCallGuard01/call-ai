# Call-delivery resilience (P0, 2026-09-29)

Branch `p0/call-delivery-resilience` (off `incident/2026-09-28-incoming-call-triage`).
Nothing here is deployed or applied. Routing (`decideCallDeliveryPlan`,
`dialHouseholdOrFailClosed`) is unchanged.

## Why

Household `f06bc964` (Android) failed **4/4** app deliveries on 24–26 Sep
2026. Two failures carried Twilio 52103, FCM `NotRegistered`, meaning the
device token was dead. One failed two minutes after the app re-registered.
For a phone with an unconditional divert, every call to the ordinary
mobile was dropped. Throughout, the app, the web dashboard and the admin
view all showed **Protection Active**. Nothing alerted beyond a per-call
email, which is rate-limited globally per type.

## 1. The path, and what happens in each failure state

```
ordinary mobile ──(carrier unconditional divert **21*)──▶ HCG Twilio number
  ──▶ POST /voice (household lookup, contacts, entitlement,
                   monitoring <Say>+<Stream> when entitled)
  ──▶ <Dial action=/call-delivery-failed timeout=20 ringTone=uk><Client>household-…</Client></Dial>
  ──▶ Twilio pushes a call invite to the registered binding (FCM on Android, APNs VoIP on iOS)
  ──▶ Voice SDK wakes the app, which shows an incoming-call notification (Android) or CallKit (iOS)
  ──▶ customer answers ──▶ Dial completes ──▶ /call-delivery-failed (DialCallStatus=completed)
                                               └▶ delivery_verified_at stamped
```

What the caller hears when delivery fails depends on whether the call was
answered before the Dial:

- **Monitored calls:** the "This number is monitored…" `<Say>` answers the
  call. The caller hears it, then up to 20 s of UK ringback, then "We're
  sorry, this call cannot be connected right now", then the call ends.
- **Known contacts:** there is no `<Say>` before the Dial. The caller hears
  ringback, then the call ends unanswered. The parent leg shows
  `no-answer 0s` in production.

| State | Twilio behaviour | Sync evidence (Dial action) | Async evidence | Before this branch | After |
|---|---|---|---|---|---|
| Valid token, answered | push → ring → answer | `completed` | app invite report | HEALTHY | HEALTHY |
| Valid token, rang, not answered | push → ring 20 s | `no-answer` | invite report (**was never recorded**: SID bug) | "delivery problem" on Home | neutral `rang_unanswered` |
| Customer declines | invite rejected | `busy`/`no-answer` | app outcome `rejected` (was never recorded) | problem | neutral |
| Caller hangs up while ringing | Dial cancelled | `canceled` / no action | app outcome `cancelled` | problem | neutral |
| FCM token expired/rotated | push to dead token | `no-answer` | **52103 NotRegistered** (Monitor alert) | invisible | UNREACHABLE after 1 |
| App uninstalled | uninstall invalidates the token | `no-answer` | 52103 NotRegistered | invisible | UNREACHABLE after 1 |
| App logged out / account switched | sign-out never unregistered with Twilio, so the old household's binding stayed live on the phone's token | the old household's calls could ring on this phone, caller number shown (unverified on a device) | — | invisible | **fixed (mobile, Build 20)**: bounded unregister before every sign-out, and wrong-household invites rejected |
| Force-stopped / background-restricted | FCM accepts; Android does not deliver to stopped apps | `no-answer` | nothing | invisible | soft ×3 → SUSPECT; hard ×2 → UNREACHABLE once the app is known to report invites |
| DB says registered, Twilio binding gone | no push attempted | `no-answer` (instant) | often nothing | invisible | as above |
| Phone offline | push not delivered in time | `no-answer` | nothing | invisible | as above |
| Dial error (SDK/Twilio) | — | `failed` | sometimes an alert | per-call email | hard |
| HCG backend down | /voice fails, Twilio 11200, "application error" | no calls row | 11200 alert, /health | health checks | not attributed to the app (correct) |

"Unverified" means it was not tested on a device in this work.

## 2. Registration health

A registration proves only that the app **could** receive calls at that
moment. The Twilio SDK's Android `onNewToken` **only logs**
(`VoiceFirebaseMessagingService.java`). It never re-registers, so a token
the OS rotates in the background leaves a dead Twilio binding until the app
next registers.

Model (`services/deliveryHealth.js`):
`UNREGISTERED | UNKNOWN | HEALTHY | SUSPECT | UNREACHABLE`.

| Evidence | Effect | Rationale |
|---|---|---|
| Delivered call (`completed`) | → HEALTHY, resets the run | the only proof of end-to-end health |
| Dead-token push failure newer than the latest registration | → UNREACHABLE (1 occurrence) | the provider says the token no longer exists; the next call will fail the same way |
| Hard failure (push failed, Dial `failed`, no invite from an app known to report invites) | SUSPECT at 1, UNREACHABLE at 2 consecutive | 1 may be transient; 2 in a row is a pattern |
| Soft failure (`no-answer`, no device evidence) | SUSPECT at 3 consecutive | indistinguishable from "didn't answer"; 2 missed calls is ordinary |
| Declined / abandoned / busy / rang-unanswered | neutral: neither counts nor resets | says nothing about app health (or proves it works) |
| New registration after failures | UNREACHABLE → SUSPECT; clears soft failures before it | f06bc964 re-registered 14:07 and still failed at 14:09, so registration ≠ healthy |
| Time alone | nothing | households call rarely and irregularly; any window is arbitrary |

`UNREACHABLE` makes `computeProtectionStatus(...).deliveryReady` and
`fullyProtected` false. This is display only; routing still attempts the
Dial, because a doomed Dial costs nothing and may succeed.

## 3. Repeated-failure detection and alerting

- `evaluateAfterDeliveryOutcome` runs after every Dial outcome is written.
  It compares health with and without the new attempt and alerts only on
  **degradation**: one alert when a household becomes SUSPECT, one when it
  becomes UNREACHABLE, none per subsequent failure.
- Push failures: Twilio reports them only asynchronously (Monitor alerts).
  `ingestPushFailureAlerts` polls every 5 min with a 10-min overlap. This
  is read-only against Twilio and idempotent. Enable it with
  `DELIVERY_PUSH_FAILURE_POLLING=on`; it is **off by default**. The Twilio
  Debugger webhook was rejected because it is an account-level console
  change.
- Alerts use the existing `sendCriticalAlert` (support mailbox), with a new
  opt-in per-household dedupe. Previously one household's alert suppressed
  every other household's alert of the same type for 30 min.
- Structured log lines are emitted as `HCG_DELIVERY_EVENT {json}`. The
  event names are `VOICE_CLIENT_PUSH_FAILED`, `STALE_REGISTRATION`,
  `REPEATED_APP_DELIVERY_FAILURE` and `HOUSEHOLD_MAY_NOT_BE_RECEIVING_CALLS`.
- **No customer notification is sent.** No approved mechanism covers this.

### Bug fixed along the way

The app reports `CallInvite.getCallSid()`, which is the **child** (client
leg) SID. `calls.call_sid` is the **parent** SID. So
`client_invite_received_at` and `client_outcome` had **zero rows** in
production, including connected calls.

The fix resolves child → parent: first via the stored `dial_call_sid`, then
via Twilio's `parentCallSid`, always scoped to the household and with the
SID format validated. It works for existing Build 19 installs as soon as it
is deployed.

## 4. Fallback options

The constraint: the customer's own mobile has an unconditional divert back
to HCG, so **any PSTN dial to it loops** (proven 15 Aug 2026). You have
ruled out a second destination number for mobiles.

| Option | Scam protection | Missed-call risk | Cost | Caller | Customer | Android/iOS | Abuse/security |
|---|---|---|---|---|---|---|---|
| **A. Current fail-closed** | full | **high**: silent drop while the app is unreachable | none | "cannot be connected" or silence | unaware | same | none |
| **B. Skip the Dial when known unreachable** | full | unchanged (the call is lost either way) | saves ~20 s ringing | apology sooner | unaware | same | false UNREACHABLE would drop calls that might have connected. **Not recommended.** |
| **C. PSTN fallback after failure** | n/a | — | — | — | — | — | **Impossible**: loops through the unconditional divert |
| **D. Backend disables forwarding** | — | — | — | — | — | — | **Not possible**: diverts are set by handset MMI codes, and no UK consumer carrier API exists (see landline carrier findings) |
| **E. Take a message (voicemail)** | preserved: only approved callers get here, and live monitoring is still attached | **low**: the message survives | recording billed per minute on top of the inbound leg; storage | normal voicemail experience | must be told a message is waiting | same | recordings are personal data: consent wording, retention, access control needed; 60 s cap bounds cost |
| **F. Tell the customer to turn off forwarding** | **none while off** | low | none | normal | must act, and remember to re-enable | same | none |

**Recommendation.** Ship alerting and visibility first (this branch). Then
build E with a customer notification when a message arrives. Use F only as
an explicit, customer-chosen step in the "unavailable" state, not as
automatic advice.

**Prototype.** `services/callDeliveryFallback.js` covers E: bounded
`<Record>` (60 s, 5 s silence), a completion route that logs metadata only,
no storage and no delivery. It is hard-disabled when `NODE_ENV=production`
and selectable locally with `CALL_DELIVERY_FALLBACK_MODE=voicemail_prototype`.
Mode `off` is byte-identical to today's response (tested).

## 5. Self-healing

- **Implemented (mobile, ships with the next build).** On every foreground,
  the app re-registers if the last successful registration is past its
  refresh point, even if the in-memory `registered` flag is still true.
  `voice.register()` re-reads the current push token, so this repairs
  tokens rotated in the background. There is no polling: at most one
  register per refresh period, and only on foreground.
- **Implemented (mobile, Build 20): unregister on sign-out.** Home
  session-expired, Account → Log out, and Delete account now call
  `unregisterForIncomingCalls()` before local reset and sign-out. It tries
  the retained registration token, then a fresh one, bounded to 4 s, and
  never blocks sign-out. The CallInvite handler also rejects an invite
  addressed to a different household identity, but only when both
  identities are known, so cold-start invites are never rejected. A
  rejected invite shows as `busy` (neutral) in the other household's
  health; the unregister fix is what removes the cause.
- **Not implemented.** Background re-registration from `onNewToken` would
  need a native SDK patch plus an authenticated backend call from native
  code. It is disproportionate before evidence that foreground healing is
  insufficient.
- **The strongest remaining lever is out-of-band.** An SMS or email to the
  customer when the household becomes UNREACHABLE ("open the app"). SMS is
  not affected by call diversion. This is a customer notification, so it
  is your decision.

## 6. Customer-visible state

Three plain states, in `deliveryHealth.status` on `/api/v1/me/dashboard`:
`active | needs_attention | unavailable`.

- **UNREACHABLE.** "Protection Active" is no longer ticked. The guidance
  reads: "Protected calls can't currently reach this phone. Open the Home
  Call Guard app to reconnect it. If this message stays, please contact
  support."
- **SUSPECT.** The steps are unchanged. The guidance reads: "Some recent
  calls may not have reached this phone. Open the Home Call Guard app to
  make sure it's connected."
- **Existing app builds.** They already map `fullyProtected=false` +
  `endToEndDeliveryVerified=true` to `reconnect_needed`, so no app release
  is needed for the unavailable state.

## 7. Dashboard contract (read model, not yet exposed as a route)

`database/deliveryEvidence.js` → `getHouseholdDeliveryHealth({ supabase, household })`:

```json
{
  "state": "UNREGISTERED|UNKNOWN|HEALTHY|SUSPECT|UNREACHABLE",
  "needsAttention": true,
  "customerStatus": "active|needs_attention|unavailable",
  "lastRegisteredAt": "ISO|null",
  "lastSuccessAt": "ISO|null",
  "lastFailureAt": "ISO|null",
  "lastFailureCategory": "push_failed|delivery_error|not_reached_device|unconfirmed_no_answer|unknown|null",
  "consecutiveFailures": 0,
  "hardFailures": 0,
  "softFailures": 0,
  "reasons": ["plain-English operator reasons"]
}
```

Events: the `HCG_DELIVERY_EVENT` log lines and alert `context.event` (§3).
Registration history: `voice_client_registration_events` (migration 046,
live). Per-call evidence: `calls.dial_call_status`,
`client_invite_received_at`, `client_outcome`, and after 055
`dial_call_sid`, `push_failure`, `push_failure_at`.

Dashboard Claude should add an admin route calling
`getHouseholdDeliveryHealth`; this branch does not touch admin files.

## 8. Diagnostic

`node scripts/triage-incoming-calls.js <household-prefix> [--since ISO]`
(read-only, masked numbers). It answers: reached HCG / app delivery
attempted / push failed / phone rang / answered, with the health state,
recent registrations and next steps. Until 055 and the poller are live,
it folds Twilio-side push failures into the health it shows.
On live data (2026-09-29): `f06bc964` → **SUSPECT**; `9cb62adb` → HEALTHY.

## Rollout order (each step needs Andrew's approval)

1. Apply 055 to staging, then production. It is additive and nullable;
   the rollback is in `_rollbacks/`.
2. Deploy the backend. The invite-SID fix starts recording device evidence
   from Build 19. Health, alerts and visibility become active.
3. Set `DELIVERY_PUSH_FAILURE_POLLING=on`, staging first.
4. Mobile foreground re-registration ships in Build 20.
5. Decide E (voicemail) and the customer notification.
