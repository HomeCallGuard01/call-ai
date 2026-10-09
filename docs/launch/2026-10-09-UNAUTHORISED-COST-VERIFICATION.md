# Unauthorised-cost verification — /media-stream and POST /process (2026-10-09)

**Scope.** Can an unauthenticated party make HCG spend money (OpenAI, Twilio SMS) through `/media-stream` or `POST /process`?
**RC:** worktree `launch/controlled-launch-2026-10-09` (code = ad545a1). **Production for comparison:** eb43368.
**Test:** `node tests/unauthorised-cost-adversarial.test.mjs` → **63 PASS, 0 FAIL, 1 residual-gap observation** (exit 0; ~45 s), after the 2026-10-09 hardening below. Also `node tests/media-stream-start-timeout.test.mjs` (8/8; the pre-fix code fails exactly the 3 targeted checks, and a genuine authorised stream stays open past the timeout in both).
No product code changed. No real Twilio/OpenAI/Supabase/Stripe call was made. Twilio REST was replaced by a spy preload, OpenAI pointed at a local counter, Supabase at a local fake with the real Fortress/056 SQL on PGlite, and every other outbound request blocked. All three servers logged zero blocked requests.

## Verdict

**The RC closes both unauthenticated-cost paths.** In every forged case: 0 OpenAI requests and 0 Twilio SMS. The SMS destination and sender always come from server-side state. **Production eb43368 is still vulnerable.** Its handler, extracted with `git archive` and run with the same forged `start` and no token, made **4 paid transcriptions and sent an SMS to the attacker-chosen `+447700900999`, from the attacker-chosen `from` number**. Its `/process` (server.js:843) has no signature check and calls `gpt-4o-mini` whenever `speech.length > 5`. The RC's handler, given the same input, closed the socket: 0 transcriptions, 0 SMS.

## Cases (all PASS on the RC)

| # | Case | Layer | Result |
|---|---|---|---|
| H1–H4 | No token; random 256-bit token; token as object/array; callSid as object; real token with a different CallSid | handler + real `streamAuth` | socket closed, 0 AI, 0 SMS; the genuine token is not consumed by wrong-CallSid attempts |
| H5 | Expired token (fake clock, TTL+1 ms) | handler | closed, 0 AI, 0 SMS |
| H6 | Valid token + forged `householdId/toNumber/protectedNumber/fromNumber` | handler | every SMS goes to the server-side mobile, from the HCG number; the outcome carries nothing forged |
| H7 | Replay of a used token | handler | closed, 0 AI, 0 SMS |
| H8 | Valid token but the meter/Fortress attach refuses / throws / refuses slowly while audio streams / returns null | handler | 0 AI, 0 SMS, stream closed |
| H9 | 16 hostile frames (null, arrays, prototype keys, 400 k nesting, 8 MiB junk, 4 MiB payload for an unknown stream) | handler | no throw, 0 AI, 0 SMS |
| H10 | No authoriser wired | handler | fail closed |
| S1 | `/voice` unsigned / wrong-key signature / signed for another AccountSid | real server.js | 403, no `<Stream>`, no stream token |
| S2–S4 | Forged WS `start` (no token, random token, stolen token with a different CallSid) | real server.js | closed; never reaches `media_stream_started`; 0 AI, 0 SMS |
| S5 | Valid token with a forged destination (**control: it IS monitored, and 1 SMS is sent**) | real server.js | spy recipient = household's own `+447700900123`, from `+441615550100`; never the attacker number |
| S6 | Replay over a new socket | real server.js | closed |
| S7 | Valid token, then a Fortress household hold | real server.js | `monitoring_safety_stop`, closed, 0 AI |
| S8 | Socket never sends `start` | real server.js | closed after ~10.0 s |
| S9 | 16 MiB text frame + 1 MiB binary + deeply nested frame | real server.js | server still healthy, 0 AI |
| S10 | 410 simultaneous unauthenticated sockets | real server.js | 10 refused with 1013 (cap 400); server healthy |
| P1–P3 | `/process` unsigned / bad signature / validly signed with `PROCESS_ROUTE_ENABLED` unset | real server.js | 403 / 403 / `<Hangup/>`; 0 AI |
| P4–P6 | Route enabled: unsigned → 403; signed + Fortress kill switch → `AI CLASSIFICATION NOT AUTHORISED`, 0 AI; **control: signed + allowed → classifier called** | real server.js | PASS |
| R1–R3 | Emergency `TWILIO_WEBHOOK_AUTH_MODE=report` + route enabled (test env) | real server.js | unsigned `/voice` gets no stream token; unsigned `/process` makes 0 AI (`isSignedTwilioRequest` gate); 0 SMS |
| C1 | `TWILIO_AUTH_TOKEN` unset or empty | guard unit | 403, even for a signature made with an empty or guessed key |
| C2–C5 | Production launch config: `report` mode (any case, declared or detected), missing token, `PROCESS_ROUTE_ENABLED=true` | launchConfig | FATAL; `enforceLaunchConfig` exits(1) |

Already covered elsewhere and not repeated: `tests/voice-surface-security.test.mjs`, `media-stream-auth-and-cost-caps`, `media-stream-concurrent-stream-cap`, `media-stream-handler-crash-hardening`, `media-stream-signature-shadow-check`, `launch-config-safety`, `twilio-webhook-auth`, `sms-fail-closed-adversarial`, `telephony-abuse-attacks`, `live-monitoring-media-stream-handler`. **All of them were re-run on this worktree: all exit 0.**

## Residual risks (none causes spend)

1. **FIXED 2026-10-09 (was GAP S8b): the start timeout could be disarmed.**
   - Before: any frame matching `"event":"start"` disarmed the timer, and a malformed start held an unauthenticated socket open. 400 of them would have blinded monitoring for genuine calls.
   - Now: only a start the handler **authorises** disarms it (`onStartAccepted`), and a malformed start is closed.
   - Asserted by S8b and by `tests/media-stream-start-timeout.test.mjs`.
2. **FIXED 2026-10-09 (was GAP S9b): no frame size limit.**
   - Now: `maxPayload` = 64 KiB, so a larger frame closes the socket with 1009.
   - Asserted by S9b and by the same test.
3. **[GAP C6] Report mode can be acknowledged in production.** `HCG_CONFIG_ACKNOWLEDGE=twilio_webhook_auth_enforced` lets production start in report mode (it is alerted, and this is by design). R1–R3 show that even then no stream token or AI spend is reachable unsigned. Signature-dependent callbacks (`/call-status`, `/call-delivery-failed`) would accept forgeries for non-money paths, and stay persist=false.
4. **`/media-stream` handshake signature is still shadow-only, and the endpoint has no per-IP connection rate limit.** Authentication rests entirely on the stream token. That is sound (256-bit, single-use, bound to the CallSid, 5-min TTL), but the token store is **in-process**. With more than one instance, streams fail closed (unmonitored), as documented in `streamAuth.js`.
5. **Production exposure stays open until the RC is deployed:** eb43368 still has the forged-stream path (AI + SMS to any number) and unsigned `/process` → `gpt-4o-mini`.

## Files

- `tests/unauthorised-cost-adversarial.test.mjs`: the adversarial suite. `[GAP]` lines are reported but do not fail the run.
- `tests/helpers/unauthorised-cost/providerSpyPreload.cjs`: a `node -r` preload for server.js. It spies on Twilio REST and blocks non-loopback network.
- The eb43368 demonstration (`scratchpad/eb43368-forged-stream.mjs` against a `git archive eb43368 services` extract) is session scratch and not committed. Its result is recorded above.
