# Incident 2026-09-28 — "normal mobile numbers not accepting incoming calls"

Reported by Andrew for his own and his son's phones, both used for HCG
testing. Investigated read-only against production Supabase
(psbzynxplxfbyrbdidmn) and the production Twilio account at ~19:00 UTC on
2026-09-28. No production data, Twilio configuration, forwarding, or
entitlement was changed. Numbers below are masked.

## Question: did the failed calls reach HCG?

Re-run the triage at any time (read-only):

    node scripts/triage-incoming-calls.js f06bc964 9cb62adb 3192e94f 4828d5b8 --since 2026-09-24

### 1. Failures on 2026-09-28 — did NOT reach HCG (scenario C)

- The production Twilio account logged **zero calls** of any kind after
  2026-09-27 11:36:57 UTC (checked unfiltered, most recent first).
- Twilio account: `active`, balance £26.47, **no Monitor alerts** since
  2026-09-27.
- Production `/health` returns 200 on www, apex, and the Railway host.
- No released HCG number is still a forwarding target: every geographic
  number that received forwarded calls since 1 Jul and is no longer in the
  account last received a call on or before 21 Sep (all test numbers). A
  diversion to one of them would fail at the carrier, but nothing shows any
  of the four households' phones using one.
- The Android app (and `@twilio/voice-react-native-sdk` 2.0.0-preview.2
  manifest) declares no ConnectionService, call-screening role,
  `MANAGE_OWN_CALLS`, `READ_PHONE_STATE` or `ANSWER_PHONE_CALLS`. HCG
  software on the handset cannot reject a cellular call.

So any call to the ordinary mobiles that failed after 27 Sep 11:37 UTC
failed at the handset/carrier before HCG. The most likely mechanism, not
yet verified on the handsets, is an unconditional divert (`**21*…#`)
still active on the handset while the carrier cannot complete the divert.
For example, a PAYG line with no credit (the diverting line pays for the
forwarded leg), a carrier-side divert restriction, or a divert to an
unexpected number.

**Handset checks (Andrew):** dial `*#21#` on each phone to show the current
divert and its target number. Compare the target with the household's HCG
number. `##21#` cancels the unconditional divert and restores normal
ringing. Check PAYG credit on the PAYG lines (Lebara/giffgaff).

### 2. Earlier failures, 24–26 Sep — DID reach HCG and HCG dropped them (scenario A)

Household `f06bc964` (internal_test, HCG number `+4413…533`, Android):

| time (UTC)       | from        | parent    | app (client) leg | push                 |
|------------------|-------------|-----------|------------------|----------------------|
| 2026-09-24 16:20 | +4479…171   | completed | no-answer        | fcm:NotRegistered    |
| 2026-09-25 18:24 | +4475…251   | no-answer | no-answer        | fcm:NotRegistered    |
| 2026-09-26 14:05 | +4477…700   | no-answer | no-answer        | —                    |
| 2026-09-26 14:09 | +4479…171   | completed | no-answer        | —                    |

- 4/4 app deliveries failed. The last successful delivery was
  `delivery_verified_at` 2026-09-19.
- Twilio error 52103, FCM `NotRegistered`: the push binding pointed at an
  FCM token the device no longer held (app reinstalled/data cleared/token
  rotated).
- The app re-registered at 14:07:01 on 26 Sep, but the call at 14:09 still
  got no answer. No push-failure alert fired for it, so the push was
  accepted but the device did not present or answer the call. That is
  consistent with the known Build 19 locked-screen banner-collapse tradeoff
  (`USE_FULL_SCREEN_INTENT` blocked), but not proven.
- By design (`/call-delivery-failed`, fail-closed, never PSTN) the caller
  hears "this call cannot be connected" or silence and is hung up on. For a
  phone diverting unconditionally to HCG, **HCG was dropping every call to
  that ordinary mobile** during this period.
- No calls have reached `+4413…533` since 26 Sep 14:09.

Household `9cb62adb` (HCG number `+4415…063`, Lebara) is healthy: it
delivered on 26 Sep and 27 Sep (latest 11:36, 58s connected).

`3192e94f` and `4828d5b8`: nothing reached them since 24 Sep.

## Verdict

- **28 Sep failures: not caused by HCG's servers.** The calls never reached
  Twilio. The phones' divert state is the thing to check.
- **24–26 Sep, `f06bc964`: HCG did drop diverted calls** (stale FCM
  binding, then an unanswered push). Structural cause: client-only delivery
  has no fallback, and nothing alerts on consecutive delivery failures for
  one household.

## Recovery

- Handset: `*#21#`, then either re-register the app (open it, confirm the
  protection-status screen) and place one test call, or cancel the divert
  with `##21#`. This is Andrew's action; no server change is needed.
- No production change is required or was made.

## Follow-ups (launch hardening, not done here)

1. Alert on N consecutive `approved_call_delivery_failed` for one household
   (the per-call alert exists; a household-level escalation does not).
2. Consume Twilio 52103 `NotRegistered` as a signal that the push binding is
   stale. Today `hasVoiceClientRegistrationHistory` treats any past
   registration as reachable indefinitely.
3. Voice Insights is not enabled on the account, so SDK-leg detail was
   unavailable for this investigation.
