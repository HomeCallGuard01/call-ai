# BYOC end-to-end test report: Magrathea to Twilio BYOC (WS7)

**Date:** 2026-10-11 · **Branch:** `launch/ws7-byoc-e2e-tests` (from launch tip `af46b8e`) · **Status:** tests only. Nothing deployed, no real service called, no live calls.

## What was built

| File | Purpose |
|---|---|
| `tests/byoc-e2e.test.mjs` | Level 2 end-to-end test. It boots the real `server.js` and sends Twilio-signed `/voice`, `/call-delivery-failed`, `/call-status` and `/media-stream` traffic shaped as inbound BYOC calls. |
| `tests/byoc-config-contract.test.mjs` | Pure test of the configuration contract: env names, fail-closed rules and launch-config rules. |
| `tests/helpers/byoc/harness.mjs` | Builds the test world: fake Supabase (filtered fixtures), RPCs running the real Fortress SQL on PGlite (`pgliteRestBridge.mjs`), a local OpenAI counter, the server boot, Twilio signing, TwiML predicates, a WebSocket probe, and a reporter with a separate WS6 section. |
| `tests/helpers/byoc/byocWebhooks.mjs` | The inbound BYOC webhook shapes. |
| `tests/helpers/byoc/byocProviderPreload.cjs` | Reuses `providerSpyPreload.cjs` (network guard plus Twilio REST spy). It adds a provider-truth answer for `Calls.json` live-call counts, scoped to each account. |

**Webhook shape.** These calls look the way Twilio presents a Magrathea DDI arriving on a BYOC trunk:
- `To` is the household DDI in E.164.
- `From` is the caller as `07…`, `+44…` or `0044…`.
- `Direction=inbound`.
- No `CallerName`, no `ForwardedFrom`/`Diversion`/`X-*` headers (Twilio drops custom SIP headers on BYOC).
- `AccountSid` is the BYOC (sub)account, and the request is signed with that account's token.

**Topologies tested.**
- **A, single account.** This is WS6's recommended setup: the BYOC trunk lives in HCG's runtime subaccount, so `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` are the subaccount's.
- **B, two accounts.** `TWILIO_BYOC_ACCOUNT_SID` and `TWILIO_BYOC_AUTH_TOKEN` are set alongside the primary account.

**How to run**

```
node tests/byoc-e2e.test.mjs              # CORE strict; WS6 section reported only
node tests/byoc-config-contract.test.mjs
BYOC_E2E_STRICT=1 node tests/byoc-e2e.test.mjs   # after merging ws6: every WS6 check strict
BYOC_E2E_STRICT=1 node tests/byoc-config-contract.test.mjs
```

The e2e run takes about 30 s, including two 5.2 s waits for the kill-switch cache.

## Results today (launch tip af46b8e)

### CORE: 35/35 PASS in byoc-e2e, 12/12 PASS in config-contract

| # | Scenario | Result |
|---|---|---|
| A1 | Trusted caller (contact E.164, caller `+44…`): `<Dial><Client>` own household, no announcement, no `<Stream>`, no PSTN leg, `timeLimit`. Fortress reservation is active, `is_known`, unmonitored. A signed BYOC dial-action settles it. | PASS |
| A2 | Unknown caller (`07…`): announcement, `<Start><Stream>` carrying only a single-use `streamToken`, Client dial with `timeLimit`. The reservation is active and monitored. A signed `/call-status` settles it. | PASS |
| A3 | A stream token issued under the BYOC call is accepted (transcribed) once and refused on replay. Any SMS goes only to the household's own mobile, from its own DDI. | PASS |
| A4 | Withheld caller (`anonymous`, `+266696687`): delivered and monitored, never trusted. | PASS |
| A5 | Unassigned DDI: bare `<Reject>`. No household id or number in the response, and no reservation attributed to any household. | PASS |
| A6 | Held household: `<Reject>` for trusted and unknown callers, nothing reserved. | PASS |
| A7 | Fortress refusal (household budget at £0), unknown caller: `<Reject>`. | PASS |
| A8 | Wrong-account token: 403, nothing reserved. Parent-token signature on a subaccount-only deployment: 403. Parent `AccountSid` with parent signature: 403. Unsigned: 403. Forged dial-action: 403. | PASS |
| A9 | Worst case, 10 simultaneous BYOC calls to one DDI: 3 delivered, 7 `<Reject>` (abuse layer `household_concurrency`). Fortress has 3 active reservations, £1.01 reserved against a £50 budget, and every admitted call has `timeLimit`. | PASS |
| A10 | Fortress kill switch on: every call is rejected, the trusted caller included. | PASS |
| — | No PSTN/SIP leg in any of the 27 responses. Zero outbound network attempts. Fortress invariants hold after the run. | PASS |
| B1–B4 | Two accounts: the hosted primary-account call is still delivered. A request claiming the primary account but signed with the BYOC token: 403. BYOC account with a wrong token: 403. Third account: 403. | PASS |
| C1–C12 | Guard and integrity layer: primary accepted; BYOC token refused when not configured; refused for primary or third-party claims; refused for an incomplete pair; refused with no token. Single-account topology accepted. Parent token refused. | PASS |

### WS6 section: 5/15 e2e and 1/23 contract pass today

| ID | Check | Today |
|---|---|---|
| W1 | Trusted contact `+44…`, caller presented as `07…`: bypass | PASS (already handled by `numberPolicy.parsePhoneNumber`) |
| W2 | Same, caller presented as `0044…` | PASS |
| W3 | Trusted caller presented as `sip:07…@hcg.sip.ie1.twilio.com;user=phone`: bypass | **FAIL** |
| W4 | `To` without the plus (`4430…`, Magrathea Request-URI form): household resolved | PASS |
| W5 | `To` as `sip:+44…@hcg.sip.ie1.twilio.com` (host contains a digit): household resolved | **FAIL**. The legacy last-10-digit key mis-keys it, the household is not found, and the call is rejected unbilled, so the customer misses it. |
| W6 | `To` in `0044…` form: household resolved | PASS |
| W7 | `sip:anonymous@…` caller: delivered, monitored, never trusted | PASS |
| W8 | Canonicalisation logged (field and form only, never a number) | **FAIL** (no normaliser) |
| W9–W13 | Two accounts: BYOC-token-signed `/voice` accepted (stream token, Client, monitored reservation); stream token accepted once and refused on replay; `/call-delivery-failed` and `/call-status` accepted and settled | **FAIL** (403: one token only) |
| W14 | Two accounts: trusted caller (national form) gets the bypass | **FAIL** (403) |
| W15 | Two accounts, worst case of 10 simultaneous calls: at most 3 delivered, within budget | **FAIL** (403) |
| K1–K2, K4–K23 | `TWILIO_BYOC_*` accepted by guard and integrity layer; `NUMBER_PROVIDER` semantics; cooling-off days; account helpers; launch-config rules; `ukNumber.toE164` | **FAIL** (modules absent). K3 passes vacuously. |

## Dry run against ws6's in-progress code (uncommitted, read-only copy)

I copied ws6's working-tree files over a scratch copy of this branch (ws6 itself was not modified):

- **byoc-e2e:** CORE 35/35, WS6 15/15.
- **config-contract (strict):** 12/12 and 23/23.

So the tests and ws6's chosen names line up.

**Finding to keep (W15 under ws6).** In two-account mode the REST client is bound to the primary account. The abuse layer's live-call check (`countLiveCalls`) therefore sees **0** BYOC-subaccount calls and clears its own concurrency leases. The 3-call bound still held, but only because 056 admission (`household_call_limit`) caught it. In single-account mode the abuse layer binds as designed. One defence layer is lost in two-account mode, which supports ws6's advice that it is for attended staging only.

## Acceptance contract for ws6

After merging ws6, run both tests with `BYOC_E2E_STRICT=1`. All four of these must hold:

1. **CORE stays green.** byoc-e2e 35/35 and config-contract 12/12. In particular, the BYOC token must never validate a request that claims the primary or a third account (B2, C3, C5). An incomplete or invalid pair must fail closed (C6, C10).
2. **W1–W8** pass: number canonicalisation, including SIP-URI `From`/`To` with a digit in the host, logged without numbers.
3. **W9–W15** pass in two-account mode, with `TWILIO_BYOC_ACCOUNT_SID` and `TWILIO_BYOC_AUTH_TOKEN` set.
4. **K1–K23** pass, matching the env names and launch rules listed in `tests/byoc-config-contract.test.mjs`.

If ws6 renames a setting (for example, a token list instead of one pair), update the `ENV`/`MODULES`/`LAUNCH_RULES` constants and the two-account env in the e2e test, and record the change here.

## Not covered (needs real infrastructure)

- How Twilio actually renders BYOC `To`/`From` (questions T14/M9). The tests cover every plausible form instead.
- Real SIP leg stacking and billing.
- Magrathea channel limits.
- Multi-instance races. PGlite is one connection; see `tests/financial-containment-realpg.test.mjs`.
