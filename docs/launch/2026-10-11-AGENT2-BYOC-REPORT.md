# Agent 2: Magrathea → Twilio BYOC, minimal variant (2026-10-11)

**Branch:** `launch/ws6-magrathea-byoc`, based on launch tip `af46b8e`. It is a local commit only: not pushed, merged or deployed.

**What was not done:** no provider was contacted, no console or account was changed, nothing was bought, and no call was placed. Migration 078 is a **DRAFT** and has not been applied anywhere.

**Default behaviour is unchanged.** With `NUMBER_PROVIDER` unset and no `TWILIO_BYOC_*` env set, every path behaves as it does on the launch tip:
- Twilio-hosted webhooks are already E.164, and the canonicaliser passes them through byte-for-byte (tested).
- The live AI monitoring path (Media Streams via Twilio) is untouched.

## 1. What changed

| # | Requirement | Change | Files |
|---|---|---|---|
| 1 | Caller/called number normalisation | New pure module. It unwraps `sip:`/`sips:`/`tel:` URIs (whose host may contain a digit, e.g. `ie1`), then delegates to the one existing parser (`numberPolicy.parsePhoneNumber`). Forms `+44…`, `07…`/`01…`/`02…`/`03…`, `0044…` and `44…` all become E.164. Withheld values stay withheld; malformed or ambiguous values give `null` and are never guessed. International numbers stay full E.164, so `+1` look-alikes never collapse onto a UK number | `services/telephony/ukNumber.js` |
| 1 | Wiring | The webhook-integrity middleware, which runs **after** the signature guard on `/voice`, `/process`, `/call-status`, `/call-delivery-failed`, `/red-line-terminate` and voicemail-complete, canonicalises `From`/`Caller`/`To`/`Called`/`ForwardedFrom` once all its checks pass. It rewrites only non-canonical values. Raw values are kept on `req.twilioRawNumberParams`, and logs record field names and forms only, never a number. The trusted-contact decision (`sameNumber`) therefore sees E.164 for BYOC national-format callers, so they match contacts stored either as legacy 10-digit or as E.164 | `services/abuse/webhookIntegrity.js` |
| 1 | `server.js` hunks | **None.** The `/voice` route line is asserted verbatim by three structural tests, so the wiring lives in the existing integrity middleware instead | — |
| 2 | Household lookup by a Magrathea DDI | `getHouseholdByTwilioNumber` canonicalises the dialled number first. `443300884327`, `0330…`, `0044…` and `sip:+44…@host;…` all resolve like `+443300884327`. The DDI is stored in the provider-neutral `households.twilio_number`. Existing Twilio numbers are unchanged, and the `+1` test still passes | `database/households.js` (+6 lines) |
| 3 | Signature validation for a BYOC (sub)account | Optional **second** account `TWILIO_BYOC_ACCOUNT_SID` + `TWILIO_BYOC_AUTH_TOKEN`. Its token is tried **only** when the request's signed `AccountSid` is exactly that SID, so it can never validate a primary-account or account-less request. The comparison is constant-time (`twilio.validateRequest` → `scmp`). An incomplete, invalid or duplicate pair is ignored, so the request is refused 403 (fail closed). The integrity layer accepts that SID too | `services/telephony/twilioAccounts.js`, `services/twilioWebhookGuard.js`, `services/abuse/webhookIntegrity.js` |
| 4 | Provisioning abstraction | `NUMBER_PROVIDER=magrathea` claims a DDI from a manual inventory instead of buying. The same gates and order apply as a purchase: abuse guard single-flight/admit, entitlement provenance, then **Fortress `authorizeNumberPurchase`**; each is fail-closed and applied by default. The DB-enforced claim, a policy re-check (UK 01/02/03 only) and assignment recovery follow. **Never calls Magrathea.** An unknown provider is held, never a fallback to buying. An empty inventory gives a failure plus a critical alert, never a Twilio purchase | `services/telephony/numberProviders/{config,inventory}.js`, `services/twilioProvisioning.js` (provider branch only), `database/routingNumberInventory.js` |
| 4 | Release | A quarantined inventory DDI is returned to the inventory with a cooling-off period (`NUMBER_INVENTORY_COOLING_OFF_DAYS`, default 30) and is **never** sent to Twilio `remove()`. An inventory read failure refuses the release | `services/twilioProvisioning.js` |
| 4 | Migration | **078_number_inventory.sql**, header `STATUS: DRAFT — NOT APPLIED`:<br>- table `number_inventory` with a `^\+44[123]…` check, one-per-household index and service_role-only access;<br>- three `security definer` RPCs with `search_path=''`;<br>- the claim is idempotent and skips held, quarantined and cooling-off DDIs;<br>- the rollback refuses while any DDI is assigned.<br>It does not depend on 062 | `supabase/migrations/078_*`, `_rollbacks/078_*` |
| 5 | Config checks | A delimited block **at the end of `RULES`**:<br>- `byoc_twilio_account_pair` (required);<br>- `number_provider_known` (required);<br>- `number_provider_magrathea_production` (**forbidden in production** until Andrew acknowledges it);<br>- `byoc_trunk_sid_recorded` (recommended; `TWILIO_BYOC_TRUNK_SID` is documentation only).<br>The env template gains commented lines (the `ws1-env-template` test requires them) | `services/config/launchConfig.js`, `scripts/production/env-template.production` |
| 6 | Docs | Staging runbook and this report | `docs/launch/2026-10-11-BYOC-*.md`, this file |

**Coordination:**
- `launchConfig.js` changes are confined to the block between `BEGIN WS6` and `END WS6`, plus one entry in `OPTIONAL_GROUPS`.
- `env-template.production` gets one commented block after `NUMBER_PROVISIONING_MODE`.
- `twilioWebhookGuard.js` is outside the listed ownership; its change is +7 lines (an optional parameter, defaulting to env).

## 2. Tests

The full suite was run in the inert env: **249 files, 248 passed.** The only failure is `android-full-screen-intent-permission` (an expo prebuild failure, which is the known baseline). Baseline was 244/245; this branch adds 4 files.

| New test | Checks | Covers |
|---|---|---|
| `byoc-uk-number.test.mjs` | 77 | All forms; SIP URI with a digit in the host; withheld and malformed values; `+1`/`+33` collisions; integrity-middleware rewrite (Twilio-hosted unchanged, refused request never rewritten); household lookup by the DDI in 6 formats; trusted matching for a national caller against legacy and E.164 rows |
| `byoc-webhook-signature.test.mjs` | 39 | Real HMAC: BYOC token accepted only for its own `AccountSid`; tampering, wrong token, missing signature and a missing primary token all fail; env default; integrity `AccountSid` set; the 4 launchConfig rules |
| `byoc-inventory-provisioning.test.mjs` | 41 | Assignment without touching Twilio; unknown provider held; production with no guard refused; abuse hold; provenance and Fortress refusals (attempts not burned); empty or unreadable inventory; policy re-check; race, committed-error and unknown-outcome assignment; default Twilio path unchanged; release goes to the inventory with no Twilio call |
| `migration-078-number-inventory.pglite.test.mjs` | 43 | Applies 000→078 and re-applies; checks constraints, claim order, idempotency, skipping of held and quarantined DDIs, cooling-off, return and release refusals, hard delete keeping the DDI held, anon/authenticated denial, rollback refusal and then success, and re-apply after rollback |
| `migration-allocation.test.mjs` (updated) | — | 078 allocated; highest = 078; rollback file present |

## 3. Known limitations

- **Two-account mode is for attended staging only.** The backend REST client is bound to `TWILIO_ACCOUNT_SID`. On a call in a separate BYOC subaccount, the Fortress lease sweeper's termination, `verifyActive` and `countLiveCalls` cannot reach the call. The bounds are then `<Dial timeLimit>` and Magrathea's channel limit.
  - **Production recommendation:** create the BYOC trunk **inside the runtime subaccount** (`TWILIO_ACCOUNT_SID`). One token is used, call control works, and the Twilio-hosted usage breaker (`352c810`) suspends BYOC traffic too.
- `/media-stream`'s shadow signature check and `isSignedTwilioRequest`'s fallback (used only on routes without the guard) still use the primary token.
- The abuse loop-check directory (households + quarantine) does not include **unassigned** inventory DDIs.
- `routing_assignments` (062, draft) is not written. Mirroring `provider_code='magrathea'` there is a follow-up once 062 is applied. 062's `acquisition` check has no `inventory` value yet.
- Magrathea CLI is presentation-only: `From`/RPID with `screen=yes` and no PAI. Trusted matching on it is the same class of risk as today; the abuse layer's spoofing suspensions still apply, but there is no `StirVerstat` on BYOC.

## 4. Remaining effort (person-days)

| Item | Estimate |
|---|---|
| Staging test (runbook) including evidence write-up | 0.5 |
| Fortress/FCC BYOC rate and usage-category entries (pessimistic £0.00907 until T1); owned by containment | 0.5–1 |
| Customer surfaces: new-number activation copy, guided re-forward, provider-policy check for 03 vs 01/02 forwarding per MNO (mobile/web, `providerPolicy.js`) | 0.5–1 |
| 062 `routing_assignments` mirroring + `acquisition='inventory'` | 0.5 |
| Dual-number grace period for migrating existing households (lookup already accepts any assigned number; the process and admin tooling are not built) | 0.5–1 |
| **Total remaining** | **≈ 2.5–4** (on top of the ≈ 2 done here; the investigation estimated 7–11 in total) |

## 5. Open questions that need provider answers

| Topic | Question | Effect |
|---|---|---|
| **Leg stacking** | T1/T2: on a BYOC inbound call delivered `<Dial><Client>`, which of BYOC $0.004, SIP interface $0.004 and Voice SDK $0.004 are billed? | Decides whether BYOC is cheaper than today **at all** (§6) |
| Ringing / increment | T3: is an unanswered ring billed on the parent leg? Is billing per second or per started minute? | Cost of unanswered calls |
| `<Reject>` | T4: is `<Reject>` £0 on BYOC? | Cost of the unknown-`To` and refused paths |
| **Account-wide channel cap** | M5: can Magrathea cap concurrent channels **across the account**, or only per DDI (10 standard / 2 trial)? | Per-DDI caps bound one household. Only an account cap is a business-wide, provider-enforced bound (≤ about £26/day at 2 channels fully stacked) |
| **Diversion visibility** | T13: is `Diversion` mapped to `ForwardedFrom` on BYOC? (Custom headers are discarded, CONFIRMED.) | No passive forwarding proof or pooling without an HCG SIP edge |
| Formats | T14/M9: how does Twilio render BYOC `To`/`From`? | Handled for every plausible form; confirm in S1 |
| Signing | T15: is a subaccount BYOC webhook signed with the subaccount token? | Two-account mode depends on it; single account avoids it |
| Registration | T19: must BYOC numbers exist as Twilio resources or bundles? | Extra console step and a possible charge |
| FQDN / auth | M7/M8: can a DDI target `S:…@<domain>`? Is digest auth available? | Without FQDN targets BYOC cannot route. Without auth, any Magrathea customer can reach the domain (mitigated by the unknown-`To` reject) |
| Commercial | M1/M2: do rentals count towards the £100 minimum? Is inbound free at volume? | Cash saving below about 200 customers |
| API | M21: `/number/*` access | Stays manual (inventory) until it is solved |

## 6. Cost table per leg scenario

List prices are from the Twilio GB page, "current as of August 2026", at $1 = £0.756. Stacking is not confirmed (NPC).

| Scenario (per minute, trusted call delivered to app) | Twilio legs | £/min | vs today | 100 trusted min/household/month |
|---|---|---|---|---|
| **Today:** Twilio-hosted number | inbound $0.010 + Client £0 (as invoiced) | 0.00756 | — | £0.76 |
| BYOC only | BYOC $0.004 | 0.00302 | −60% | £0.30 |
| BYOC + SDK leg | BYOC + Client $0.004 | 0.00605 | −20% | £0.61 |
| **BYOC + SIP interface + SDK (fully stacked)** | 3 × $0.004 | 0.00907 | **+20%** | £0.91 |
| Unknown caller, monitored: add | Media Stream $0.0044 (£0.00333) + Whisper ≈ £0.0047 (OpenAI) | +0.00803 | — | — |
| `<Reject>` (unknown `To`, refusals) | none if T4 holds | 0 | — | — |
| Magrathea inbound leg | — | £0 (trial, written) | — | — |

| Number per household | Monthly |
|---|---|
| Twilio GB local (invoiced) | £0.87 (list $3.50 = £2.65, T12) |
| Magrathea DDI | £0.50, subject to the £100/month account minimum (M1) |

**Worst case bounded by Magrathea channels**, at the fully stacked rate, every channel busy:
- 2 channels: £1.09 per hour, £26 per day;
- 10 channels: £5.44 per hour, £131 per day, **per DDI** unless M5 gives an account-wide cap.

## 7. Recommendation

1. **Merge only after T1 and M5/M7 are answered.**
   - If T1 says all three legs stack, BYOC costs more than today, and its value is then only the carrier channel cap.
2. If the answers are favourable, run the runbook (cap £2). Then put the trunk in the runtime subaccount (single account) for production and acknowledge `number_provider_magrathea_production` only on Andrew's explicit approval.
