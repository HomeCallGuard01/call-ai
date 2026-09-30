# Call-delivery telemetry and admin diagnostic (30 Sep 2026)

Goal: never again have a customer say "the phone didn't ring" and be unable to establish why.

Code: `services/callDeliveryEvents.js`. Storage: migration **058** `call_delivery_events` (DRAFT, not applied). Admin read: `GET /admin/api/households/:id/call-delivery-timeline` (`routes/adminDeliveryTimeline.js`).

## Events

| Event | Source | Where | Detail (allow-listed only) |
|---|---|---|---|
| `inbound_received` | server | `/voice` entry | — |
| `household_identified` / `household_not_found` | server | `/voice` | — |
| `caller_classified` | server | `/voice` | `classification`: known_contact / unknown / withheld |
| `routing_decision` | server | after the (unchanged) dial | `mode`, `monitoring`, `entitled`, `endpointRegistered`, `registrationAgeHours` |
| `push_requested` | server | client-only plan | `timeoutSeconds` |
| `push_failed` | poller | Twilio Monitor alert ingest (52103 etc.) | `reason` e.g. `fcm:NotRegistered` |
| `app_invite_received` | app | CallInvite | `platform`, `presented` |
| `app_ringing` | app | invite with presentable UI | `platform` |
| `app_presentation_blocked` | app | SDK error 31401 | `platform`, `errorCode`, `cause` |
| `app_answered` / `app_declined` / `app_invite_cancelled` | app | CallInvite events | `platform` |
| `app_media_connected` | app | Call Connected | `platform` |
| `dial_outcome` | server | Dial action callback | `dialCallStatus`, `durationSeconds` (carries the parent and child SIDs, which joins the app events) |
| `delivered` / `delivery_failed` | server | Dial action / routing | `durationSeconds` / `reason` |
| `fallback_triggered` | server | apology, unavailable message, voicemail prototype | `type` |
| `device_readiness` | app | registration, foreground change, 31401 | `platform`, `microphone`, `notifications`, `osVersion`, `trigger` |

## Privacy

- **No caller number, name, transcript, summary or free text can be recorded.** Every event has a per-event allow-list of enum, boolean and small-integer fields. Any string that looks like a phone number is dropped even inside an allowed key. This is tested.
- The table has no caller column. `detail` is capped at 2,000 bytes.
- RLS is on, with no anon/authenticated policies (service_role only). Rows cascade with the household.
- App reports use `requireAuthApi`. The household comes from the token, never the body, and the unauthenticated `/debug` beacon pattern is not used.
- Retention: **90 days proposed, not enforced.** This is your decision.

## Safety

- Never on the call path: every server call is fire-and-forget, wrapped, and never awaited in a TwiML handler (tested).
- `dialHouseholdOrFailClosed` and the monitoring gate are untouched. Routing telemetry recomputes the same pure decision separately.
- **Two-stage enable:**
  1. Deploying the code gives `HCG_CALL_DELIVERY {json}` log lines only.
  2. After migration 058 is applied, set `CALL_DELIVERY_EVENTS_DB=on` for DB writes. A missing table logs one error and fails open.

## Diagnosis

`buildDeliveryTimeline` groups events per call and names the first stage that didn't happen:

| Diagnosis stage | Meaning (operator text) |
|---|---|
| household | HCG number not linked to a household |
| routing | no registered app, so HCG did not try to ring |
| push | push failed (dead token / rejected): the customer must open the app |
| presentation | the call reached the app, but a missing permission blocked the ring |
| device | Dial issued, but the phone never reported the call: dead token, force-stopped/battery-restricted, offline, or a non-reporting build |
| answer | rang unanswered / declined / caller hung up |
| media | answered, but never connected |
| connected | delivered |

**The 30 Sep 12:42 call would now read: "device — HCG asked Twilio to ring the app, but the phone never reported receiving the call".** It would come with the registration age, the monitoring flag and, once the poller is on, any 52103.

## Admin view spec (UI not built; the JSON route exists)

On the Customers › household page, add a "Call delivery" panel:
1. **Header:** delivery health state and reason (existing `getHouseholdDeliveryHealth`), last registration (age), last delivered call, and the latest device readiness (mic/notifications chips, red when denied).
2. **Recent calls list** (14 days, newest first): time, caller classification (never the number), routing mode, **diagnosis sentence**, and a stage strip of the pipeline stages as filled or hollow dots (inbound → routed → push → invite → ringing → answered → connected), with the push → invite latency in seconds.
3. **Filters:** failed only / all.
4. No caller numbers anywhere on this panel. Linking to the existing Activity row is by call SID.

## Rollout (each step needs your approval)

1. Deploy the backend (logs only). This is independent of Build 20; old app builds are unaffected.
2. Apply 058 on staging → `CALL_DELIVERY_EVENTS_DB=on` on staging → one test call → admin route shows the full timeline.
3. The same on production.
4. Build 20 adds the app-side events and readiness.
5. Decide retention, and whether a UNREACHABLE readiness state should notify the customer.
