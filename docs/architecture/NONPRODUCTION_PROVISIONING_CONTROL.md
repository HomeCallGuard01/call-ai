# Non-production number provisioning control

Status: guard implemented on `feature/nonprod-provisioning-guard` (d3caeb9), not merged or deployed.
No provider or account configuration has been changed.

## Problem (evidence, 2026-09-27)

- There is one Twilio account and no sub-accounts. Local and staging servers run with the **production** Twilio credentials.
- 19 numbers are billed at £0.86917/month each.
- Voice webhook hosts on those numbers:

  | Host | Numbers |
  |---|---|
  | `www.homecallguard.co.uk` | 8 |
  | `homecallguard.co.uk` | 1 |
  | an ngrok dev tunnel | 8 |
  | an old Railway domain | 1 |
  | none | 1 |

- 7 of the 19 belong to STAGING households. A staging signup or entitlement bought a real number, and staging has no release lifecycle behind it.
- Sandbox/TestFlight purchases reach the same path in production (see the RevenueCat sandbox handoff).

## Options compared

| Option | Stops staging buying on the prod account | Keeps realistic end-to-end tests | Needs provider config | Residual risk |
|---|---|---|---|---|
| A. Twilio sub-account for staging | Only once staging credentials are swapped; nothing stops a dev pasting prod credentials again | Yes (real numbers, real calls) | Yes: create sub-account and move the staging env | Staging numbers still cost money with no cap. Sub-account spend rolls up to the parent invoice. |
| B. Fake/mocked provider (`NUMBER_PROVISIONING_MODE=fake`) | Yes, for the purchase | No real inbound calls (a drama-range number is not routable) | No | UI and onboarding tests only |
| C. Environment guard in code (implemented) | **Yes, by construction.** Non-production can never buy on the production account, whatever credentials it holds. | Via A plus explicit `live` mode | No | A misconfigured production that fails the signature. Mitigated by a critical alert and the attempt limit. |
| D. Allow-listed App Review/test paths | Doesn't stop staging on its own | Yes, for named reviewer/test households | No (code/data) | The allow-list must be curated. Belongs to P0 (entitlement boundary). |

## Recommendation

1. **C now.** It is the only option that closes the hole without trusting configuration hygiene:
   - production is recognised from values it already has: `APP_URL` host plus Supabase project ref;
   - a mixed configuration is blocked;
   - non-production may buy only with `NUMBER_PROVISIONING_MODE=live`, `PRODUCTION_TWILIO_ACCOUNT_SID` declared and different, and fewer than `NONPRODUCTION_MAX_NUMBERS` (default 3) numbers owned.
2. **B for local development.** Set `NUMBER_PROVISIONING_MODE=fake` on developer machines.
3. **A later (DECISION REQUIRED).** Create a staging sub-account when real-call staging tests are needed. Set `NUMBER_PROVISIONING_MODE=live` and `PRODUCTION_TWILIO_ACCOUNT_SID` on staging. The cap limits exposure to about £2.61/month.
4. **D is P0's.** App Review and internal testing need a real number on production. That comes from an explicit, bounded, classified entitlement (e.g. `internal_test` with an end date), not from a sandbox purchase silently provisioning.

## Deployment prerequisites (not done)

- **Pre-deploy check (blocking).** Confirm production Railway `APP_URL` is `https://www.homecallguard.co.uk` or `https://homecallguard.co.uk` and `SUPABASE_URL` is project `psbzynxplxfbyrbdidmn`. If `APP_URL` is anything else (e.g. the Railway domain), set `PRODUCTION_APP_HOSTS` first, or every new customer is refused a number.
  - The guard raises `twilio_provisioning_blocked_by_guard` and records a provisioning failure.
  - The failure appears on the admin onboarding monitor.
- After deploy, staging will stop buying numbers. Staging tests that need a number must use `fake` mode until a sub-account exists.
- **Coordination.** P0 branches also edit `services/twilioProvisioning.js`. This change is a single block inserted after `shouldAttemptProvisioning`, so it should rebase cleanly. P0 decides merge order.

## Tests

`tests/provisioning-guard.test.mjs` has 22 checks. They cover:

- the real ngrok + staging + production-SID case;
- mixed configurations;
- the modes;
- sub-account and cap rules;
- the hook never calling the provider when blocked;
- production being unchanged;
- the production-process alert.

Full suite: 106 files, 3,815 passed, 9 failed. The 9 failures are the same Android manifest checks that fail on main in this environment.
