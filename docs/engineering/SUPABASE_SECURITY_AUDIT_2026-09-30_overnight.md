# Supabase / data-access security audit — 2026-09-30 (overnight)

Scope: the database and Data API attack surface of the two Supabase projects,
`tigwgmayeuisrxjjykqd` (staging) and `psbzynxplxfbyrbdidmn` (production).
Builds on the earlier remediation (057–059) recorded in
`SUPABASE_SECURITY_REMEDIATION_2026-09-30.md`.

**Production was read-only all night.** Every production query ran inside
`begin transaction read only … rollback`; a deliberate write test was rejected
with `25006`. Production received only GET probes with `limit=0`. **No
production migration was applied.** Staging migrations 060 and 061 were applied
and verified.

## 1. Staging security status

Staging carries migrations 057–061. All automated and live checks pass:

- `scripts/verify-table-grants.js` — all checks pass.
- `scripts/verify-security-definer-grants.js` — all checks pass.
- `scripts/probe-anon-data-api.js` — every public table/view returns 401/42501 to anon; anon sees 0 storage buckets.
- Security Advisor — no ERROR; one WARN remains (`auth_leaked_password_protection`, an Auth dashboard toggle). The `function_search_path_mutable` WARN is now cleared on staging by 060.
- `tests/migrations.pglite.test.mjs` — passes, including the new default-ACL, canary, view, trigger and migration-lint checks; replays cleanly under both staging's and production's default-ACL models.
- Full suite: 103/105 test files pass; the 2 failures are Android-native checks needing `mobile/node_modules`, unrelated to data security.

## 2. What the Data API actually exposes (both projects)

- Only the `public` and `graphql_public` schemas are reachable through PostgREST (`Accept-Profile: storage/auth/...` → PGRST106). `pg_graphql` is **not** enabled, so `graphql_public.graphql()` errors out for anon even though the route returns 200.
- Installed extensions are identical and minimal: `pg_stat_statements`, `pgcrypto`, `uuid-ossp`, `supabase_vault`, `plpgsql`. **No `pg_net`, `http`, `pg_cron`, or `dblink`** — the database itself has no outbound-network or scheduling primitive, so it cannot be turned into an egress or cost engine from SQL alone.
- Storage: 0 buckets, 0 objects; `storage.*` RLS on; anon bucket-create and object-upload both refused (RLS). Not exposed via PostgREST.
- No sequences in `public` (all PKs are `uuid`), so sequence privileges are moot.
- Schema `CREATE` is not held by anon/authenticated on any schema.
- `anon` and `authenticated` are `NOBYPASSRLS`; `service_role` is `BYPASSRLS` (expected). No realtime publications.

## 3. New findings (this pass)

| # | Severity | Finding | Where | Status |
|---|---|---|---|---|
| A | **P2** (staging) / **P3** (prod) | `authenticated` held direct Data API grants on `contacts` (SIUD), `subscriptions` (SELECT), `entitlements` (SELECT) from 008/011. RLS limited them to the user's own household, so no cross-household leak — but a signed-in user could write their **own** trusted contacts straight through PostgREST, bypassing the backend's validation (10-digit UK number, duplicate check, 500-contact sync cap). Trusted contacts decide which callers skip AI screening, so an unvalidated/oversized list degrades that household's screening. | `contacts`/`subscriptions`/`entitlements` grants | **Fixed in 060** (staging). In the prod package. |
| B | **P3** | `public.hcg_set_updated_at()` had a mutable `search_path` (Advisor WARN) and was EXECUTE-able by anon/authenticated. Body only calls `now()`, so not independently exploitable, but it is unnecessary surface and a standing Advisor finding. | trigger function | **Fixed in 060** (staging). In the prod package. |
| C | **P2** (latent) | Migration 022's `ALTER DEFAULT PRIVILEGES … IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM public` is a **no-op** against PostgreSQL's built-in global default. Per-schema default privileges can only add to the global set, never subtract the built-in "PUBLIC may EXECUTE new functions" grant. Confirmed by a rolled-back staging canary: a freshly created function has `proacl = NULL` and `has_function_privilege('anon', …, 'EXECUTE') = true`. Nothing is exposed today (every existing RPC revokes PUBLIC explicitly), but one future `SECURITY DEFINER` migration that forgets its revoke line would be anon-callable via `/rest/v1/rpc`. | global default ACL | **Fixed in 061** (staging, global `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE … FROM public`). In the prod package. |
| D | **P3** (ops, out of DB scope) | Production backend's service-role key is present in ~21 local `.env` files across sibling worktrees on this machine (not in git — `.gitignore` covers `.env*`, history scan for JWT/secret literals is clean). One tracked file, `call-ai-staging-safety/.env.staging.example`, contains a 29-char placeholder, not a real key. Blast-radius note in §5. | developer machine | Reported; no rotation tonight (per instructions). |

Re-confirmed from the prior pass (still true, in the prod package, not yet fixed in prod): **terms_acceptances RLS off in production** (057), and **authenticated table-wide INSERT/UPDATE on households** lets a signed-in user create a household with arbitrary server-controlled columns (059 column-scopes it). The founder **default-household** claim policy is unchanged (needs a product decision).

## 4. Cross-household isolation (Priority 2)

Verified two ways.

**Application layer (code read):** every authenticated route derives the
household from the session (`req.household` set by `requireAuth`/`requireAuthApi`
from the auth cookie/bearer, looked up by `auth_user_id`). No non-admin route
accepts a household id, user id, or `auth_user_id` from the client. The only
client-supplied ids are contact ids on `PUT/DELETE /contacts/:id` and the
mobile equivalents, and every one is queried as `.eq("id", contactId).eq("household_id", req.household.id)`
— a contact id from another household matches zero rows (404). Admin routes
take `:id` but sit behind `requireAdmin` (`user_roles.role === 'admin'`).

**Database layer (staging, two disposable users A and B, each with its own
household, number, contact, call and entitlement; all rolled back or deleted,
0 residue confirmed):**

- RLS policies are byte-identical on both projects and scope every
  authenticated policy to `household_id IN (SELECT id FROM households WHERE auth_user_id = auth.uid())` (or `auth_user_id = auth.uid()` for households/user_roles).
- As `authenticated` with A's JWT: `select` over households / contacts /
  subscriptions / entitlements returned **only A's own rows** (0 of B's).
  `calls` and `terms_acceptances` returned 42501 (no grant at all).
- Cross-household UPDATE/DELETE of B's contact id as A: 0 rows affected.
- `user_roles` self-insert is constrained by policy to `auth_user_id = auth.uid()` and `role = 'household'`; inserting `role = 'admin'` → 42501 (the privilege-escalation check below).

No cross-household read, update or delete path was found at either layer.

## 5. Privilege escalation (Priority 3)

Searched systematically: INSERT/UPDATE policies (`pg_policies`), every
`SECURITY DEFINER` function's parameters, triggers, role mapping, and the
server-controlled columns on each sensitive table.

- **Role escalation to admin:** `user_roles.role` has a CHECK of
  `{admin,support,household}`, but the INSERT policy pins `role = 'household'`
  and `auth_user_id = auth.uid()`. There is no UPDATE policy, so an
  authenticated user cannot change an existing role row. Setting `admin` on
  insert → 42501 (verified, rolled back). `getUserRole()` reads `user_roles`
  via `supabaseAdmin`; a user cannot write it. **No escalation path.**
- **Server-controlled household columns** (`twilio_number`, `activation_verified_at`,
  `delivery_verified_at`, `self_protecting`, `carrier_*`, `status`,
  `stripe_customer_id`): after 059 the authenticated INSERT grant is
  column-scoped to `auth_user_id,email,status` and UPDATE to `auth_user_id,email`.
  Attempting to set `twilio_number` or `activation_verified_at` on insert, or to
  update `twilio_number`, all return 42501 (verified on staging, rolled back).
  Every other write to these columns is a `SECURITY DEFINER` RPC granted to
  `service_role` only. **This is the pattern the brief named; 059 closes it and
  no other table has an equivalent broad grant.**
- **Billing/entitlement state:** `subscriptions`/`entitlements` are
  service-role-write only; after 060 authenticated has no grant at all. All
  writes go through `process_stripe_webhook_event` and friends
  (`SECURITY DEFINER`, `service_role`-only, `search_path=""`). A user cannot
  grant themselves an entitlement or a Twilio number through the DB.
- **Financial-limit fields:** the financial ledger tables (`financial_entries`,
  `telephony_call_legs`, `finance_*` views) exist only on staging and are
  service-role-only with RLS on; views are `security_invoker=true`. No
  authenticated or anon access.
- **All 19 (prod) / 29 (staging) `SECURITY DEFINER` functions:** `service_role`
  EXECUTE only, `postgres`-owned, `search_path=""`. anon/authenticated RPC
  calls return 42501. Parameters are all scalars; each function internally
  scopes by the `p_household_id` it is given (callable only by the trusted
  backend, which passes the session's own household id).

## 6. Default privileges / future migrations (Priority 4)

- **Tables/sequences:** 058 (staging) makes the `postgres`/public default grant
  nothing to anon/authenticated. Canary in the test harness: a table created
  after all migrations grants anon/authenticated nothing.
- **Functions:** 061 (staging) removes the built-in global PUBLIC EXECUTE
  default. Canary: a function created after all migrations is not EXECUTE-able
  by anon/authenticated (`proacl` now `{postgres=X/postgres}`, not NULL).
- **Regression tests added** (`tests/migrations.pglite.test.mjs`, run on every
  `npm test`):
  - replays the whole chain under staging's permissive default ACL (worst case);
  - asserts anon has zero privileges and authenticated matches the exact table/column allowlist;
  - table **and** function canaries start closed;
  - no owner-privileged (non-`security_invoker`) view is readable by anon/authenticated;
  - the updated_at trigger is pinned, non-executable, and still fires;
  - a **static lint over every migration file**: no `GRANT … TO anon`, no `GRANT ALL TO authenticated/PUBLIC`, no `DISABLE ROW LEVEL SECURITY`, no `ALTER DEFAULT PRIVILEGES … GRANT` (only the pre-existing `000_baseline_contacts_table.sql` is allowlisted).
  - Negative controls: removing any of 057/058/059/060/061 makes the corresponding checks fail.

## 7. Service-role / secret blast radius (Priority 5, read-only)

- **Where used:** `services/supabaseClients.js` builds `supabaseAdmin` from
  `SUPABASE_SERVICE_ROLE_KEY`; it is imported by the `database/*` helpers,
  `routes/*`, and the `services/businessMetrics/*` modules — all server-side.
  The key is never sent to the browser or the mobile bundle. The client/mobile
  surface uses only `EXPO_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_ANON_KEY`
  (anon), which is public by design and now governed by RLS + least-privilege
  grants.
- **If the service-role key leaked:** it is `BYPASSRLS` and can read/write every
  table and call every RPC — full data compromise and the ability to flip
  entitlements or Twilio assignments. This is inherent to the service-role
  model; the mitigation is key secrecy + rotation, not grants.
- **Narrower privileges possible?** Yes, as a future hardening: the business-
  metrics/read paths only need SELECT and could use a dedicated read-only
  Postgres role via a separate connection string rather than the
  all-powerful service-role key. Out of scope for tonight (needs a new role +
  secret, i.e. a deploy).
- **Separation:** staging and production use distinct projects, distinct keys,
  and `services/serverConfig.js` validates the running process is pointed at a
  real production domain before boot. **Finding D:** the production service-role
  key is copied into ~21 local `.env` files in sibling worktrees on this
  developer machine. Not in git (verified). Recommend consolidating local env
  usage and rotating the production service-role key on a schedule — flagged,
  not actioned tonight.

## 8. Cost-amplification through DB/API (Priority 6)

Looked specifically for ways Data API / DB access makes HCG spend money.

- **Fake households / mass signup:** `/register` requires a real Supabase Auth
  signup (email confirmation on; `mailer_autoconfirm=false`). A household row
  cannot be created without a confirmed auth user (RLS ties it to `auth.uid()`).
  Signup is not rate-limited at the app layer, but creating a household alone
  incurs **no** cost — a Twilio number is only purchased on an active
  entitlement (Stripe payment or admin/complimentary grant), and AI monitoring
  only runs for an entitled household on a real inbound call. **Not a direct
  cost path.**
- **Creating/modifying telephony destinations:** `households.phone_number` /
  `twilio_number` cannot be set by an authenticated user (059 column grants +
  RPC-only writes). The backend **never dials `phone_number` from the Data
  API path** — the live call path only does `<Dial><Client>` to the app, and
  `phone_number` is validated to E.164 UK and loop-checked before storage. **No
  toll-fraud dial path from DB access.**
- **Triggering SMS:** the only `messages.create` is the scam-warning SMS, whose
  recipient is the household's own `phone_number` (from the call's
  `customParameters`, set server-side), de-duplicated to **at most one warning
  SMS per call** (`warningSent` latch). Not reachable or amplifiable through the
  Data API.
- **Triggering calls / AI processing:** both require a real Twilio inbound call
  to a provisioned number; there is no DB/API endpoint that starts a call or an
  OpenAI transcription. `/media-stream` (the OpenAI cost path) is a WebSocket
  with a concurrent-stream cap (200) — see the known gap below.
- **Manipulating subscription/usage state:** service-role-only (see §5). No DB
  path for a user to grant themselves entitlement.
- **Retry/event storms:** no `pg_cron`/`pg_net`; the only schedulers are two
  in-process `setInterval`s (24h) for Twilio number release. Stripe/RevenueCat
  webhooks are idempotent (`claim_stripe_webhook_event`, event-ordering guard).

**No new P0/P1 cost-amplification path reachable through the database or Data
API was found.** Two pre-existing, non-DB items remain owned by Claude A and
are out of this scope but worth restating as the real cost gates:
`/media-stream` has only a shadow-mode Twilio signature check (authentication
not enforced; concurrent-stream cap is the only hard bound), and there is no
per-household daily/monthly minute cap. Both are app/telephony-layer, not
database-layer.

## 9. Anything that blocks launch (data-security view)

- **No data-security launch blocker remains on staging.**
- **Production:** apply the 057–061 package (below). Until then, production has
  RLS off on `terms_acceptances` (not anon-reachable today) and the
  arbitrary-column household-insert hole (B/059). Neither is currently
  exploitable by anon, but both should be closed before broad launch. This is a
  **should-fix-before-launch**, not an active incident.
- Out of data scope but launch-relevant (Claude A): `/media-stream`
  authentication and per-household spend caps.

See `SUPABASE_PRODUCTION_RUNBOOK_057-061.md` for the exact, ordered production
change awaiting Andrew's approval.
