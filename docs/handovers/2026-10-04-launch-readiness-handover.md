# Handover: launch readiness audit (2026-10-04)

**Nothing was deployed, submitted, applied or changed.** No staging, production or
provider read or write. No EAS build or submit. No App Store Connect or Play Console
access. The only changes are two new docs on a new branch.

## 1. Branch and worktree

| | |
|---|---|
| Branch | `release/launch-readiness-2026-10-04` (pushed; upstream is its own name, not `main` or the integration branch) |
| Worktree | `/Users/ad/call-ai-launch-readiness` |
| Base | `origin/integration/launch-fortress-2026-10-03` @ `2011ab6` (the latest integration branch; already contains `p0-batch1-carrier-policy-quarantine` 91f9577) |
| HEAD | the commit adding this file (`git log -1`) |

## 2. Deliverables

- `docs/release/2026-10-04-SOFT_LAUNCH_READINESS.md`: every item classified READY / NEEDS STAGING PROOF / NEEDS BUSINESS DECISION / EXTERNAL WAIT / BLOCKED. It covers:
  - the release-candidate determination;
  - backend-versus-old-build compatibility;
  - the 17-step staging sequence;
  - the production sequence;
  - decisions B-1…B-14;
  - the store checklist (not submitted);
  - the rollback summary.

## 3. Key conclusions

1. **Backend RC: `2011ab6`.** Gate CLOSED (correct: there is no staging evidence yet).
2. **Mobile RC (Android and iOS): `2011ab6`.**
   - Its mobile tree = `release/ios-1.0.2` `cb710dd` + the allowance meter.
   - New builds are required: Android 1.0.2 versionCode ≥ 22 (vc 21 was used by the staging APK) and iOS 1.0.2 Build 15.
   - Android Build 19 (`a1fcede`) and iOS Build 14 (`1f24483`) lack the sign-out unregister, call readiness / 31401, the giffgaff/Three forwarding number, dynamic price and allowance honesty. The iOS build also lacks the iPhone path.
3. **No backend change breaks an already-shipped build.**
   - Old builds are degraded: a misleading "protected" state under enforcement, the sign-out ringing bug, and a generic error on premium contacts.
   - Deploy the backend before releasing the apps.
4. **Hard blockers:**
   - LEVEL 4 provider containment (external evidence);
   - migrations unapplied;
   - production signature proof;
   - commercial values / price;
   - Android Play Billing (Play Production only);
   - iOS screenshots;
   - no real-device proof of any 1.0.2 build;
   - staging can't buy numbers while it shares the production Twilio account.
5. **Configuration hazards found:**
   - `ABUSE_AUDIT_HASH_SECRET` and `SAFETY_CALLER_KEY_SECRET` fall back to **hard-coded** secrets (`services/abuse/abuseAudit.js:30`, `services/usage/callAdmission.js:57`).
   - With `TRUST_PROXY_HOPS` unset, per-IP auth rate limiting is off (`server.js:259`).
   - Fortress economics default to £5.99 (`services/containment/economicPolicy.js:27`) while the live price is £4.99.
   - None of the new variables is in `REQUIRED_IN_PRODUCTION`.
   - `/webhooks/provider-usage-alert` sends no email.
   - These are recorded, not fixed (this branch is audit-only).

## 4. Evidence sources

- Integration docs `docs/integration/2026-10-0{3,4}-*`.
- Launch-gate `docs/launch-gate/*`.
- `docs/launch/IOS_102_*`, `STORE_LISTING_COPY.md`, `TERMS_BILLING_DRAFT_2026-10-01.md`, `ANDROID_CALL_CHAIN_AUDIT_2026-09-30.md`.
- `~/hcg-staging-handset-test/README.md` (Motorola Phase A done; B–E pending; the staging APK expires 2026-10-16).
- `git diff` across `a1fcede`, `1f24483`, `cb710dd`, `eb43368` and `2011ab6`.
- Two read-only audit subagents (mobile builds; store, pricing and configuration). I spot-checked their key claims against the files.

## 5. Not established

- **Play Production track state:** no record found.
- **What used Android versionCode 20.**
- **EAS remote environment variable values** (not in the repo).
- **The live Stripe Price.**
- **Twilio account balance model.**

## 6. Tests run here

- `npm test` on `2011ab6`: 178 files.
  - 162 passed with no environment set.
  - The other 16 failed only on `supabaseUrl is required` and then passed 16/16 with dummy offline Supabase and Stripe values.
  - So 178/178 effectively pass.
- `*-realpg` suites were skipped (no `FC_REALPG_MODULES`).
- `mobile`: `tsc --noEmit` passes with 0 errors.
- Worktree setup: `node_modules` symlinks were created for the run and removed afterwards (both git-ignored).

## 7. Next step

Andrew reviews §8 of the readiness doc (decisions B-1…B-14). In parallel:
- send the drafted Twilio questions;
- set up a staging Twilio sub-account.

Then execute §6 of the readiness doc on staging, step by step, with approval.

## 8. Resume

```
cd /Users/ad/call-ai-launch-readiness && git status && git log --oneline -3
ln -s /Users/ad/call-ai/node_modules node_modules
ln -s /Users/ad/call-ai-launch-fortress/mobile/node_modules mobile/node_modules
SUPABASE_URL=http://127.0.0.1:1 SUPABASE_ANON_KEY=dummy SUPABASE_SERVICE_ROLE_KEY=dummy STRIPE_SECRET_KEY=sk_test_dummy npm test
```
