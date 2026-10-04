# Handover — HCG unit economics & allowance model v1 (2026-10-04)

**Branch:** `finance/unit-economics-v1` · **Worktree:** `/Users/ad/call-ai-unit-economics`
**Base:** `integration/launch-fortress-2026-10-03` @ 2011ab6 (the latest integration branch)
**Deployed / provider / database changes:** **none**.
- No price, allowance, `fc_policy` or `fc_budget_profiles` row was touched. No migration was added or applied.
- No Stripe, App Store, Play or Twilio setting was touched.

## 1. What was asked

Resolve the contradictory cost assumptions (£0.50 / £0.86 / £1.25 budgets, and the "100 minutes ≈ £2.07" figure). Trace every input to its source, build one auditable model at £5.99 incl VAT and ~40% gross margin, and compute candidates without choosing the policy. Make runtime policy derive from one set of assumptions.

## 2. What was delivered

| Deliverable | Path |
|---|---|
| Decision document | `docs/finance/HCG_UNIT_ECONOMICS_V1.md` |
| Generated tables (every number, reproducible) | `docs/finance/HCG_UNIT_ECONOMICS_V1_TABLES.md`, from `node scripts/hcg-unit-economics.js [price]` |
| Authoritative assumption register (machine-readable; each entry has value, unit, status, kind, source) | `services/finance/assumptions/hcg-unit-economics.v1.json` |
| Register loader/validator | `services/finance/economicsRegister.js` |
| Model (revenue, fixed, budget, minute costs, scenarios, top-up pricing, Fortress conversion, legacy reconciliation) | `services/finance/hcgUnitEconomics.js` |
| Contradiction checks | `services/finance/economicsConsistency.js` → `commercialConfigValidation.js` (boot log + admin overview) |
| Drift/identity tests | `tests/economics-register.test.mjs` (53 checks) |

**Runtime modules now reading defaults from the register.** Values are unchanged; env overrides behave as before.
- `services/usage/costModel.js`
- `services/containment/economicPolicy.js`
- `services/finance/unitEconomics.js`
- `services/finance/carrierComparison.js`
- `services/finance/pricingScenarios.js`
- `services/allowance/productCatalog.js`
- `services/usage/plans.js`

Older docs `PRICING_AND_ALLOWANCE_EVIDENCE.md` and `UNIT_ECONOMICS_AND_PROVIDER_REQUIREMENTS.md` carry a "superseded for decisions" note.

## 3. Key findings (details in the doc)

1. **The legacy figures measure different things** (doc §2):
   - **£0.86** = the economicPolicy envelope (15% store channel, infra placeholder, 15% reserve, £0.10 overrun).
   - **£0.50** = its 58% budget slice.
   - **£2.07** = 100 minutes at *Fortress enforcement* rates × 1.10.
   - **£1.25** has **no source** in any branch. The best reconstruction is £1.239: the envelope without the infra placeholder and with a 10% reserve.
2. **Safe usage budget at £5.99, 40%, Twilio today, billed basis** (base case: £0.25 infra, 2% leakage, 15% reserve, £0.10 overrun):

   | Channel | Safe budget | Trusted minutes | Monitored minutes |
   |---|---|---|---|
   | Stripe | **£1.07** | ≈ 123 | 61 |
   | Apple SBP / Google 15% | **£0.74** | ≈ 85 | 42 |
   | Apple 30% | **£0.10** | ≈ 11 | 5 |

3. **The illustrative typical household (150 trusted + 40 unknown minutes) misses 40% on every channel at £5.99.** It reaches 26% on Stripe. Trusted minutes alone use up the safe budget on every channel at about 150 minutes/month.
4. **The Fortress charges usage at 1.33–1.56× the billed cost** (app leg at list + ×1.10). Profiles must be converted: Stripe £1.07 → £1.54, stores £0.74 → £1.06.
5. **Apple SBP enrolment (UNKNOWN) is the largest single swing** on the Apple channel.
6. **Telephony:**
   - **Network-side trusted routing** (AQL/MVNO/FMC) is the only modelled change that makes typical and heavy households fit. Typical margin goes 30% → 56% on Stripe.
   - **Magrathea free inbound** looks better still, but HCG's own SIP/media infrastructure is not costed.
   - **Telnyx per-minute** changes ~2 points.

## 4. Decisions for Andrew (not taken here)

| # | Decision | Where the evidence is |
|---|---|---|
| U1 | Price (£5.99 still unapproved) and whether 40% is per customer or portfolio | doc §5, §6.1 (C1–C5), §6.5 |
| U2 | Fortress £ profiles (replacing the £0.50 / £0.25 / £0.10 placeholders) on the enforcement basis. Per-channel profiles, or worst-channel | doc §6.2 |
| U3 | Included monitored minutes (the 100/200 placeholders cannot be funded by the seeds) | doc §6.1, boot warning `plan_minutes_unfundable` |
| U4 | Warning points: £ (50/75/90/100%) vs today's minutes (75/90%); operator WATCH/LOSS lines | doc §6.3 |
| U5 | Top-up packs and retail prices per channel; trusted/unmonitored £ capacity packs | doc §6.4 |
| U6 | Higher tier price and its budget | doc §6.5 |
| U7 | Reserve policy: plan 15% vs top-up 10%; overrun; uplift | register `planSafetyReserveRatio`, `topUpSafetyReserveRatio` |
| U8 | Whether to pursue network-side trusted routing (economically decisive) | doc §8 |

## 5. Provider confirmations required

In order of impact:
1. Apple SBP enrolment.
2. Real per-household inbound minutes.
3. Twilio: app leg stays unbilled (written).
4. Stripe: fee schedule, Billing %, Tax on/off, card mix.
5. An OpenAI usage-readable key.
6. Supabase, Resend and IONOS invoices.
7. AQL, Magrathea and Telnyx quotes.
8. Accountant: input VAT recovery.

## 6. Verification (exact)

Run as `npm test` with the documented offline dummy env:
- `SUPABASE_URL=http://127.0.0.1:54321`
- `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_KEY` = `dummy`

Results:
- **Before my changes** (rewired defaults only): 178 files, 178 passed, 7,669 ✓.
- **Final:** **179 files, 179 passed, 0 failed; 7,722 ✓, 0 ✗** (the new `economics-register.test.mjs` adds 53 checks).
- `FC_REALPG_MODULES` (embedded-PostgreSQL race suite) was **not set**, so that suite skipped. That accounts for the difference from the integration handover's 7,694. No SQL was changed.

Worktree dependencies:
- `node_modules` is a symlink to `/Users/ad/call-ai/node_modules`, the same convention as sibling worktrees, with an identical lockfile.
- `mobile/node_modules` is a symlink to `/Users/ad/call-ai-launch-fortress/mobile/node_modules`, also with an identical lockfile.
- Both are git-ignored.

## 7. Merge notes

- Pure JS + JSON + docs. No migration.
- It touches files that other branches also touch: `commercialConfigValidation.js`, `productCatalog.js`, `plans.js`, `costModel.js`, `economicPolicy.js`.
- Conflicts would be small (default declarations only). After any merge, run `node tests/economics-register.test.mjs`: it fails if a branch reintroduces a literal or changes 067 defaults without the register.
- If migration 067 is renumbered, update the path in the test.
- `research/carrier-routing-v2` uses FX £0.75/$, while the register uses £0.79/$. Align them when that branch is merged.

## 8. Not done

- No usage data was queried, since production reads are out of scope and there is no real distribution.
- No live price or fee was read from Stripe or ASC (no access).
- The Fortress SQL defaults cannot read the register. They are pinned by the test instead.
- `services/businessMetrics` dashboard costing was not re-based on the register. It has its own known under-costing issues (memory: unit-economics-2026-09) and is a follow-up.
