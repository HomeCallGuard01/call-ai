# Handover: Customer lifecycle & operations automation (2026-10-04)

**Nothing was deployed or merged. No migration was applied, and no database (production or staging) was read or written. No provider (Twilio, Stripe, RevenueCat, Supabase, Apple, Google, Resend) was contacted or reconfigured. No customer was messaged.**

## 1. Branch / worktree / base
- Branch: `feature/customer-lifecycle-automation`, pushed to `origin`. Upstream is set to its own remote branch, **not** `main` or the integration branch.
- Worktree: `/Users/ad/call-ai-customer-lifecycle`.
  - `node_modules` is a symlink to `/Users/ad/call-ai/node_modules`.
  - `mobile/node_modules` is a symlink to `/Users/ad/call-ai-launch-fortress/mobile/node_modules`.
  - Both are git-excluded.
- Base: `origin/integration/launch-fortress-2026-10-03` @ `2011ab6`, the latest integration branch.
- A sibling session works in `/Users/ad/call-ai-accounting-automation` (`feature/accounting-automation`, same base). This branch adds **no migration**, to avoid number collisions with it.

## 2. Deliverables
- `docs/operations/CUSTOMER_LIFECYCLE_AUTOMATION.md` is the full audit:
  - lifecycle map (§2);
  - state machine (§3);
  - "protected" inconsistencies (§4) and the wiring plan (§5);
  - manual-intervention inventory (§6);
  - communications (§7);
  - number lifecycle and cost leaks (§8);
  - search (§9);
  - exception queue (§10);
  - privacy/retention (§11);
  - findings F-01…F-12 (§12) and decisions (§13).
- Code (all pure or read-only):
  - `services/lifecycle/{activationState,exceptionQueue,communicationsPlan,numberRetirement,supportSearch}.js`
  - `database/lifecycleSnapshot.js`
  - `routes/adminLifecycle.js`, mounted in `server.js` next to the Fortress admin routes
  - `database/adminMetrics.js` `searchCustomers` (classifier, former-number lookup, filter sanitising)

## 3. Behaviour changes
1. **Admin search** (`GET /admin/api/search`). Phone queries in any UK format now match stored E.164 exactly. A routing number a household *used to* hold is found via `routing_assignments`; this is skipped when 062 is absent. Text is sanitised before it enters the PostgREST `.or()` filter. Account-number, UUID and email behaviour are unchanged; the existing tests pass.
2. **Two new admin GET endpoints**, both requireAuth + requireAdmin:
   - `/admin/api/lifecycle/exceptions`
   - `/admin/api/lifecycle/households/:id`

   Neither writes anything (tested).
3. Nothing customer-facing changed. `computeProtectionStatus` and every customer response are untouched.

## 4. Tests (exact, this session)
- Command: `SUPABASE_URL=http://127.0.0.1:9 SUPABASE_ANON_KEY=dummy-anon SUPABASE_SERVICE_ROLE_KEY=dummy-service npm test`
- Result: **182 files, 182 passed, 0 failed; 7,853 ✓, 0 ✗.**
- Without the dummy Supabase env, 17 suites fail at module load with `supabaseUrl is required`. The same happens on the untouched base worktree, so this is the environment, not this branch.
- The two real-PostgreSQL suites skipped themselves (`FC_REALPG_MODULES` not set). This branch changes no SQL.
- New files:
  - `lifecycle-activation-state` 38 checks, including all 8,192 combinations of 13 failure causes; exactly one is protected;
  - `lifecycle-journey` 101: signup → … → deletion, plus queue quietness and no-write/no-provider source checks;
  - `lifecycle-support-search` 23;
  - `admin-lifecycle-routes` 22: auth, non-admin, unapplied migrations, fail-closed hold, 500 on a required table failing.
- Mutation check: removing any one of `notOnHold`, `numberNotQuarantined`, `forwardingVerifiedForCurrentNumber` or `entitledNow` from the gate list makes the activation test fail.

## 5. Verified by hand vs audit-reported
Verified by hand this session:
- `computeProtectionStatus` ignores hold, quarantine and entitlement.
- F-03 (deletion → Stripe failure loop; 029:122 + 070:50-54/150-157).
- Stripe `HANDLED_TYPES`.
- The sweep is off by default (`server.js:3211`).
- There is no confirm-deactivation UI.
- The `privacy.html:498` contradiction.
- RevenueCat `BILLING_ISSUE` is ignored.
- `fortressAdapter` never reads a hold.
- The Account tab uses `hasProvenActivation`.
- Quarantined numbers are never adopted.
- F-12.

Everything else in the doc comes from a structured read-only audit with `file:line` citations. F-10 is explicitly unconfirmed.

## 6. Top findings
- **F-01:** abandoned numbers need a human to release them, and there is no UI to do it.
- **F-02:** held, quarantined or renumbered households are shown as protected.
- **F-03:** the account-deletion Stripe retry loop (fix proposed, not applied).
- **F-04:** payment failure, disputes and refunds are ignored.
- **F-05/F-06:** number cost leaks from date-lapsed memberships and from returning customers.
- **F-07:** no lifecycle messages.
- **F-08:** the privacy policy doesn't match the deletion code.

## 7. Decisions needed (doc §13)
- D-N1 (enable the sweep)
- D-N2 (auto-confirm after N days)
- D-N3 (reinstate vs replace for returning customers)
- D-N4 (number cost)
- D-B1–B3 (payment issue, refunds, parallel channels)
- D-C1–C5 (which messages, the channel, all wording, and the `on_hold` copy)
- D-O1 (thresholds)
- D-P1 (forwarding re-verification)
- **D-W1:** wire the state machine into customer surfaces (plan in doc §5)
- D-R1–R9 (privacy/retention)

## 8. Recommended next steps (none started)
1. Andrew decides D-W1. Then do step 1 of doc §5 (server-only: `fullyProtected = activation.protected`) with `on_hold` copy.
2. Fix F-03 (small, in `routes/billing.js`, with a test).
3. Add an admin UI for the lifecycle queue, a confirm-deactivation button, and a confirm-by-quarantine-id route (N-2/N-3).
4. Decide D-N1/D-N2. These are the only levers that stop indefinite number spend.
5. A lifecycle outbox table plus approved copy for `service_ending` first. It must carry "turn off forwarding" instructions.

## 9. Resume
```
cd /Users/ad/call-ai-customer-lifecycle && git status && git log --oneline -3
SUPABASE_URL=http://127.0.0.1:9 SUPABASE_ANON_KEY=dummy-anon SUPABASE_SERVICE_ROLE_KEY=dummy-service npm test
node tests/lifecycle-activation-state.test.mjs && node tests/lifecycle-journey.test.mjs
```
