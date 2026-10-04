# Provider-level financial containment (LEVEL 4) — launch-blocking requirement

**Status: RED launch blocker. Nothing here has been verified or changed by this work.**
No provider was contacted and no provider setting was read or changed. Every HCG
application control (levels 1–3) can be bypassed by anyone holding the provider
credentials, by an application bug outside the Fortress path, or by a provider-side
routing/configuration error. Level 4 is the only control that survives those.

**A spend ALERT is not a spend LIMIT.** An alert tells someone; a limit stops the
spending. Only limits count towards closing this blocker.

## 1. Defence-in-depth hierarchy

| Level | Control | Where | Proof today |
|---|---|---|---|
| 1 | Per-call authorisation / reservation before any HCG-funded leg; leases; `<Dial timeLimit>` | Fortress (067) + server.js | test-proven locally (PGlite + real PostgreSQL 12-way) |
| 2 | Per-household economic cap + per-household financial hold (manual/automatic, audited, unbypassable) | Fortress (067) | test-proven locally (`fortress-kill-switches`, `defence-in-depth`, integration) |
| 3 | HCG-wide latched spend/rate breaker, kill switch, exposure/active caps | Fortress (067) | test-proven locally |
| 4 | Provider/account hard ceiling and restrictions | Twilio / OpenAI / Supabase / Stripe consoles | **UNPROVEN — no evidence** |

`tests/defence-in-depth.pglite.test.mjs` proves levels 1–3 each stop spend alone. Level 4
cannot be tested in code.

## 2. What the repository already records (evidence, not re-verified)

| Fact | Source |
|---|---|
| Twilio usage triggers configured: **0** (2026-09-27) | `docs/finance/PROVIDER_SPEND_PROTECTION.md`; `docs/finance/COST_CONTROL_AUDIT_2026-09-27.md` #3 |
| One Twilio account, **no sub-accounts**; staging and local development bought numbers on the production account | `COST_CONTROL_AUDIT_2026-09-27.md` #1 |
| "Twilio has no hard account cap" (design assumption, not confirmed in writing) | `PROVIDER_SPEND_PROTECTION.md` control #1 |
| The backend holds the **master** Twilio auth token | catastrophic-risk review 2026-10-01 (session records) |
| Outbound voice geographic permissions turned off; SMS geographic permissions and auto-recharge still pending in the Console | zero-idle-spend audit 2026-09-30 (session records; not re-verified) |
| OpenAI: the project key cannot read costs; no project budget known | `COST_CONTROL_AUDIT_2026-09-27.md` #10 |
| A usage-trigger receiver exists (`/webhooks/provider-usage-alert`, signature-verified, **alert only**) and a script to create triggers (`scripts/provider-usage-triggers.js`, not run) | server.js; scripts |

## 3. Settings that must be verified (and evidenced with a dated export/screenshot) before unrestricted launch

### Twilio
1. **Voice geographic permissions:** every country **off** for outbound voice (HCG has no outbound PSTN product path). Include the "high-risk special services" / premium options.
2. **SMS geographic permissions:** **GB only**. Everything else off, including premium/short-code destinations.
3. **Auto-recharge:** **off** (or a low maximum). With a prepaid balance and auto-recharge off, the balance is the effective hard ceiling — **confirm with Twilio in writing** whether the account can go negative, and by how much.
4. **Account balance model:** prepaid vs invoiced. An invoiced/post-paid account has no natural ceiling — confirm.
5. **Usage triggers** on `totalprice` (daily and monthly) and `phonenumbers` (count). These are **alerts**. Decide whether a trigger callback should invoke an **independent** suspension (e.g. a small service holding a separate credential that suspends a sub-account via the API) — that would turn the alert into a provider-side stop. Confirm suspension semantics (does suspension end live calls? block inbound?).
6. **Sub-accounts:** move production telephony into a dedicated sub-account (and staging into another). **Confirm** whether a sub-account can have its own balance/limit or only shares the parent's (blast-radius question).
7. **Credentials:** rotate the master auth token; give the backend a **standard/restricted API key** scoped to what it needs (calls read/update, incoming numbers, messages) — confirm which scopes Twilio supports; keep the master token offline. Webhook signature validation needs the auth token of the account that owns the numbers — confirm the arrangement with a sub-account.
8. **Number purchasing:** confirm whether purchasing can be restricted (e.g. require a separate credential not held by the web backend, or a regulatory-bundle gate). HCG code caps purchases at 10/day globally and per household, but a stolen credential is not bound by HCG code.
9. **TwiML App (Voice SDK) Voice URL:** confirm it points only at HCG's `/voice` (which rejects client-originated calls) and that the outgoing grant cannot reach PSTN.
10. **Fallback URL on every HCG number:** set to a static `<Reject>` (or TwiML Bin) so calls arriving while HCG is unreachable are not answered/billed by default — confirm behaviour.
11. **Account-level "maximum call duration" / 24-hour call setting:** confirm it is not raised (HCG sets `timeLimit` itself, but a call created outside HCG would not have it).

### OpenAI
12. A **project budget with a hard stop** (confirm it is a stop, not just an email), an Admin read-only usage key for reconciliation, and the backend key scoped to the one project.

### Supabase / email
13. Auth email provider rate limits and cost model (sign-up / reset emails): confirm SMTP provider limits and that no paid per-email overage is uncapped.

### Stripe / RevenueCat / stores
14. These receive money rather than spend it; confirm no paid add-ons with usage pricing are enabled (Stripe Tax and Radar fees are per transaction — bounded by sales).

## 4. Questions to put to Twilio (in writing) — drafted, NOT sent

1. Is there any hard spend limit or credit ceiling on an account or sub-account, after which all billable activity stops? If not, what is the maximum negative balance a prepaid account can reach with auto-recharge off?
2. Do sub-accounts have independent balances or limits, or do they draw on the parent's balance?
3. If an account or sub-account is suspended via the API, do in-progress calls end, and are inbound calls to its numbers rejected unbilled?
4. Which API-key scopes can exclude number purchasing and outbound calling while allowing call status reads/updates and messaging to GB?
5. Do geographic permissions also block premium/special-service ranges inside allowed countries (e.g. UK 09/087/070)?
6. Is a `<Dial timeLimit>` measured from the child leg or the parent, and is the parent billed beyond it?

## 5. Pass criterion for closing the blocker

Dated evidence for items 1–11 (Twilio) and 12 (OpenAI), a written Twilio answer to §4 Q1–Q3,
and an explicit decision by Andrew on the residual exposure that remains after those settings
(e.g. "maximum loss with a stolen credential = prepaid balance + permitted negative balance").
Until then: **HCG must not be described as financially protected.**
