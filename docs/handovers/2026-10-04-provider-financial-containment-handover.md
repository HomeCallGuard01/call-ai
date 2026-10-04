# Handover: provider financial containment audit (2026-10-04)

**No provider account was read, changed or contacted. No call was placed. No number was bought or released. Nothing was deployed or merged. No AQL email was sent.**

## 1. Branch, worktree, base
- **Branch:** `research/provider-financial-containment`, pushed to `origin`. The upstream is its own remote branch, deliberately not `main`.
- **Worktree:** `/Users/ad/call-ai-provider-financial-containment`. Two dependency folders are symlinks, both git-ignored:
  - `node_modules` → `/Users/ad/call-ai/node_modules`
  - `mobile/node_modules` → `/Users/ad/call-ai-launch-fortress/mobile/node_modules`
- **Base:** `origin/integration/launch-fortress-2026-10-03` @ `2011ab6`.
- **Head:** the commit that adds this file (`git log -1`).

## 2. Deliverables
| File | What |
|---|---|
| `docs/integration/2026-10-04-PROVIDER_FINANCIAL_CONTAINMENT_FINAL.md` | The final audit. It covers:<br>• HCG's provider cost surfaces from code<br>• classification of every Twilio and OpenAI control (HARD / APPLICATION / ALERT / UNKNOWN / NOT AVAILABLE)<br>• the exposure model per threat<br>• the target architecture<br>• alternative carriers<br>• Twilio questions Q1–Q12<br>• the LEVEL 4 pass criterion<br>• sources |
| `docs/integration/2026-10-04-TWILIO_CONTAINMENT_CHECKLIST.md` | 32 exact steps for Andrew covering Twilio, OpenAI and the written questions. **Not executed** |
| `docs/integration/2026-10-04-PROVIDER_FINANCIAL_CONTAINMENT.md` | Banner added: superseded. Content unchanged |
| `docs/finance/PROVIDER_SPEND_PROTECTION.md` | Corrected the OpenAI row: a budget stops requests only when "Enforce a hard limit" is on |
| `tests/launch-gate/registry.mjs` | Evidence and notes for C10 and S20 now cite the final audit. **Status unchanged (UNPROVEN / FAIL)** |

## 3. Key findings
1. **Twilio has no account spend limit.** Its own words: "There is no maximum spend limit setting."
   - Usage triggers are **alert only**.
   - The only provider stop is suspension at zero balance, and it leaks: in-progress calls finish and the balance can go negative by an undocumented amount. Twilio's fraud guide says it "does not often suspend right at zero".
2. **Guaranteed maximum Twilio loss today: none (unbounded).** The backend holds the **master** Auth Token (`services/twilioClient.js:9`). That token can:
   - re-enable voice geo permissions through the API
   - repoint the TwiML App and numbers
   - buy numbers
   - mint keys
   - rotate the token silently
3. **Only SMS geo permissions cannot be changed by API.** Voice geo, fallback URLs, TwiML App URLs and triggers can all be changed by the credentials HCG holds.
4. **Best achievable bound** = prepaid balance + overrun + number rental. It needs four things:
   - a production subaccount
   - the main token kept offline
   - a Restricted backend key (no `calls/create`, no number purchase)
   - an independent trigger → suspend breaker

   Even then, the overrun is undocumented, so it needs Twilio's written answers to **Q1–Q4**. Two residuals remain:
   - the Voice SDK minting key must be a Standard key, because Restricted keys cannot mint tokens
   - webhook validation still needs a subaccount Auth Token, unless Webhook SharedKeys (beta) cover Voice
5. **OpenAI can be hard-capped now** (since July 2026), with organisation and project hard spend limits that return 429.
   - Limits are monthly only, with a "slight" overshoot.
   - Auto-reload is **on by default**.
   - Hitting the limit stops transcription; calls still connect.
6. **Code gaps found.** Listed in FINAL §5; not fixed here because they are runtime changes.
   - Numbers are bought with **no `voiceFallbackUrl`**, so calls during an HCG outage are answered with an error and billed.
   - `/process` `<Dial>` has no timeLimit and no reservation. It is dormant.
   - The usage-alert receiver does not trip the Fortress breaker.
   - An SMS is sent anyway if the 056 claim throws (it is still Fortress-authorised).
   - Purchase, SMS and transcription velocity counters are process-local.
7. **Alternatives.** These are better outbound primitives, but anything a stolen API key can change is still not a hard limit.
   - Magrathea: prepaid outbound with restricted tariffs.
   - Telnyx: outbound voice profiles with `daily_spend_limit`, `max_destination_rate` and `concurrent_call_limit`, all settable through the API.

## 4. Launch gate
**LEVEL 4 / R3 remains RED.** The pass criterion is in FINAL §8:
- dated Console evidence
- OpenAI hard limits enforcing
- Twilio written answers to Q1–Q4
- Andrew's recorded residual

GREEN additionally requires the §5 architecture, drilled on staging.

## 5. Tests
Command:
```
SUPABASE_URL=http://127.0.0.1:9 SUPABASE_ANON_KEY=dummy SUPABASE_SERVICE_ROLE_KEY=dummy APP_URL=http://localhost:3000 npm test
```
- Result: **178 files, 178 passed, 0 failed; 7,669 ✓, 0 ✗.** The real-PG modules were not set; the base handover's 7,694 included them.
- Without the dummy environment, 16 files fail on `supabaseUrl is required`.
- Without `mobile/node_modules`, 7 files fail.
- Both failure groups are environment-only, and both existed before this work.

## 6. Decisions for Andrew
- When to run the checklist (A is read-only; B–G change settings).
- The prepaid balance B.
- OpenAI org and project limits.
- Whether to send Q1–Q12 by support ticket.
- Fallback = `<Reject>` rather than an answered apology.
- Turning off GB voice geo too (HCG has no outbound PSTN).
- Whether to adopt the subaccount + Restricted-key architecture, and who owns the code changes in FINAL §5.

## 7. Resume
```
cd /Users/ad/call-ai-provider-financial-containment && git status && git log --oneline -3
```
