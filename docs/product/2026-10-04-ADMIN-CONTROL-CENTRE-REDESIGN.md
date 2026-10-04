<!--
STATUS (2026-10-04): DESIGN FOR APPROVAL. Branch feature/admin-control-centre-redesign,
pushed, NOT merged, NOT deployed. No database, provider, store or price change.
Previews use SYNTHETIC data only.
-->
# Admin Control Centre redesign (2026-10-04)

| | |
|---|---|
| Branch | `feature/admin-control-centre-redesign` (pushed; not merged, not deployed) |
| Worktree | `/Users/ad/call-ai-admin-redesign` (`node_modules` and `mobile/node_modules` are git-ignored symlinks to existing installs) |
| Base | `integration/soft-launch-candidate-2026-10-04` @ `b0e46dd` |
| Previews | `docs/admin/previews/2026-10-04-redesign/{before,after}/*.png` (synthetic data) |
| Tests | 198/198 files, ✓8,756 ✗0 (see §11) |

## 1. Starting point: what was merged and what was not

- **`feature/admin-control-centre-v2` is already fully contained in the soft-launch candidate.** `git rev-list --count soft-launch..v2` = **0**; the candidate merged it at `fa525e5`, with migration 055 renumbered to 069. Nothing needed merging. The redesign is built on the candidate tip, so every newer launch and security change is kept:
  - the commercial classifier;
  - canonical protection;
  - the Fortress, lifecycle, ops-event and accounting routes;
  - the containment fixes.
- **The candidate's admin page never displayed its newest functionality.** `admin-business.html` called none of these:
  - `/admin/api/fortress/overview`
  - `/admin/api/lifecycle/*`
  - `/admin/api/ops-events`
  - `/admin/api/accounting/*`

  They existed only as backend routes.
- `/Users/ad/call-ai-soft-launch-candidate` has another session's uncommitted work: `docs/launch/*`, `scripts/staging/` and an `alerting.js` change. It was **not touched**.

## 2. Audit of the existing Admin Control Centre

### Inventory (before)

| Area | Contents | Source |
|---|---|---|
| Overview | "Needs your attention", built client-side from v2 cards, legacy customer health and system health. Then **13 "Checks" cards** in 3 groups, each with a rule. Then a glossary. | `/business-control/overview`, `/customers/onboarding`, `/business/overview` |
| Customers | 4 summary cards, 5 health filters and 4 audience filters. A 9-column table (Customer, Account, Health, Setup, Network·device, App, Last confirmed, Latest call, View). Detail panel: setup timeline, recent calls, account and device, actions, classification. Then a 13-card "Memberships & payment history" block. | `/customers/onboarding`, `/households/:id/status`, `/business-control/subscriptions` |
| Numbers | Provider inventory in 8 categories, with a release-review **prototype** whose final button is permanently disabled. Household lifecycle chain per household. | `/business-control/overview` (inventory), `/business-control/reconciliation` |
| Money | Spend safety (8 tiles). P&L, lines with provenance, unit economics, fixed costs, data sources. Marketing / UTM link builder. Website funnel. | `/business-control/finance`, `/marketing`, `/business/overview` |
| Operations | Usage & cost safety, call activity, fair use, release info, system health (7 components). Admin tools: search, retry provisioning, complimentary grant/revoke, F&F invites. Due-diligence snapshot, launch readiness, recent activity. | several |
| Not shown anywhere | Fortress breaker, kill switch, holds and budgets. Lifecycle exception queue. Canonical activation stage. Ops events and notification deliveries. Accounting/Xero status. HCG account numbers (outside search). | routes existed, UI did not |

### Problems found

1. **Two competing "genuine" definitions on one page.**
   - The v2 Overview stated *"Genuine = explicitly classified genuine customer"* (`services/businessControl/definitions.js`).
   - The soft-launch candidate made `services/commercial/commercialStatus.js` the one genuine-paying rule.
   - The Customers tab used the second; the Overview cards and "Memberships" block used the first.
   - Result: the same page could show different genuine counts. In the synthetic preview the v2 card says "5 genuine paying" while also flagging "2 paid at some point, not classified".
2. **Legacy protection logic.**
   - Customers and the v2 "Protected" card use `computeProtectionStatus` (three timestamps), not the canonical `activationState` (nine gates).
   - So a customer on a financial hold, with a quarantined number, or with proof for a **previous** number could read "Healthy / Protected".
   - Before: a past-due Stripe customer reads **Healthy**.
3. **Misleading counts.**
   - "Setup overdue — *Paying for protection that is not active yet*" listed reviewer and sandbox accounts.
   - The Customers tab flag (4) counted test accounts.
   - "Active protected households 5" mixed genuine and test.
   - "Churn 100%" was shown for 1 of 1.
4. **Wrong hierarchy.** The Overview opened with 13 technical cards (Twilio-numbers-not-mapped, lifecycle anomalies, rental). Andrew had to read them to answer "how many customers do I have?".
5. **Identity.**
   - Customers were identified by email.
   - Search invited "Twilio number".
   - The permanent HCG account number did not appear in the customer list at all.
6. **Missing actions.**
   - Nothing linked an attention item to the customer it was about.
   - The September-incident pattern was flagged only as one of several "Needs attention" reasons in a long table.
7. **Branding.**
   - Navy (#0b1220) with cyan (#22d3ee) accents and Arial, with "Home Call Guard" as plain text.
   - No logo, and nothing of the website's black-green palette, HCG green or Inter.
8. **Small defects.**
   - System health rendered component reasons without escaping.
   - Opening `#money` (etc.) made the browser jump to the panel, so the top of the tab was hidden under the header. Visible in the BEFORE captures.

## 3. Navigation (after)

Five tabs, unchanged, so bookmarks and legacy hashes still work:

| Tab | Answers | Contents, top to bottom |
|---|---|---|
| **Overview** | "What is the state of the business right now?" | Highlights (new genuine customer / customer protected / customer needs attention) → 4 KPIs → HCG status (5 rows) → Needs your attention → Today & recent activity |
| **Customers** | "Who are my customers and is each one OK?" | Segment filters + search → 8-column table → row opens journey, what needs doing and key facts → **support diagnostics** (the previous detail panel and classification, unchanged) → *Membership & payment history* (collapsed) |
| **Numbers** | "What numbers am I paying for, and why?" | Numbers at a glance (6 groups with £/month; reserved staging notice) → previous inventory and lifecycle (unchanged apart from the reserved number) |
| **Money** | "Am I making money, and is exposure under control?" | £5.99 inc-VAT launch notice → 8 money cards → highest-cost customers → previous finance detail, provenance, Xero / data sources, marketing, funnel |
| **Operations** | "Is the service working, and what is the technical detail?" | Service & safety status (Fortress, abuse, Twilio, OpenAI, Stripe webhooks, notifications, accounting, background jobs; emergency-control note) → usage & cost safety → call activity → system health → **Detailed business checks** (the former Overview grid + definitions) → admin tools |

## 4. Before vs after

All screens are SYNTHETIC: 12 invented households, `example.com` addresses, fictional numbers, and the staging test number shown masked.

| Screen | Before | After |
|---|---|---|
| Overview | `before/1-overview.png` | `after/1-overview.png` |
| Customers | `before/2-customers.png` | `after/2-customers.png` |
| Customer detail (September-incident customer) | `before/3-customer-detail.png` | `after/3-customer-detail.png` |
| Money | `before/4-money.png` | `after/4-money.png` |
| Numbers | `before/5-numbers.png` | `after/5-numbers.png` |
| Operations | `before/6-operations.png` | `after/6-operations.png` |
| Phone (390 px) Overview | `before/7-mobile-overview.png` | `after/7-mobile-overview.png` |

Paths are relative to `docs/admin/previews/2026-10-04-redesign/`.

The synthetic data is the first-five-customers scenario:

| Customer | Situation |
|---|---|
| 1 | Protected |
| 2 | New today, setting up |
| 3 | Paid; forwarding works; app never registered: **the September incident** |
| 4 | Apple production, protected yesterday |
| 5 | Protected but payment past due |

It also includes one account of every non-genuine kind (complimentary, internal test, reviewer, TestFlight sandbox, environment-unverified store purchase, former customer, sign-up only), two quarantined numbers, and the staging number.

## 5. Exactly what changed

### New (additive, read-only)

- **`services/adminControlCentre/summary.js`** (pure). It builds the founder summary by **composing** the canonical modules:
  - `classifyCommercialStatus` for genuine;
  - `householdExceptions` / `buildExceptionQueue` for protection stage, gates and exceptions;
  - `detectOpsEvents` for the needs-attention reasons.

  It adds only admin wording:
  - segment labels;
  - stage labels;
  - plain-English blockers and titles;
  - the customer journey;
  - recent activity in the last 7 days.

  Telephone numbers are masked to the last 3 digits, and no email is returned.
- **`routes/adminControlCentre.js`** adds `GET /admin/api/control-centre/summary`:
  - `requireAuth` + `requireAdmin`;
  - `Cache-Control: no-store`;
  - one `loadLifecycleSnapshots` call;
  - answers **503** if it cannot load, never "0 customers".

  `server.js` gains one mount line beside the other admin routes.
- **`tools/admin-preview/`** is the preview harness, never served by `server.js`:
  - `fixtures.js` builds synthetic inputs and runs the REAL pure builders (canonical summary, onboarding rows, control overview, inventory, subscriptions, reconciliation, usage safety, Fortress overview).
  - `serve.js` is a 127.0.0.1-only static server. Its in-page `fetch` stub serves those fixtures, answers 405 to every write, and shows a permanent "SYNTHETIC PREVIEW DATA" strip.
  - `screenshot.sh` + `trim.py` capture the screenshots with Playwright's headless shell.
- **`tests/admin-control-centre-redesign.test.mjs`**: 68 checks, see §11.

### Changed: `admin-business.html`

- **Brand**: tokens on `:root` taken from `public/index.html` (`--bg #050a07`, `--green #3cf07a`, Inter). Every navy/cyan literal is mapped to a token (134 replacements). The header has the existing `/hcg-shield.png` logo, "HOME CALL GUARD" / "Admin Control Centre", and the logo as favicon.
- **Overview** is rebuilt (new `controlCentre` block). The v2 grid moved to Operations as "Detailed business checks", with a note that it uses classification.
- **"Needs your attention"**: when the canonical summary is loaded, it is built from the canonical exception queue, grouped:
  - *Genuine customers* first;
  - then *Business & operations*, which also includes the v2 business checks the queue does not cover (unmapped numbers, spend safety, usage signals, system health, data freshness, payments attribution);
  - then *Also worth knowing* (FYI).

  v2 topics already covered by the canonical queue are not repeated. The v2 "classify accounts" step is dropped from this list: the commercial classifier does not need it. Without the summary, the previous v2 list is shown unchanged.
- **Customers**: new renderer.
  - Columns: HCG account | Customer | Membership | Protection | Setup (5 dots) | Last activity | Attention.
  - Segment filters, and search by account number.
  - Genuine customers sort first, the most urgent at the top; non-genuine rows are greyed, never hidden.
  - The detail row shows the journey, what needs doing (with next step), why the customer is not protected and key facts. The existing diagnostics follow, unchanged.
  - The old summary strip, the health/audience chips and the row renderer are removed; the pure helpers they used are kept and still tested.
- **Numbers**: "Numbers at a glance" groups (genuine / complimentary-test-reviewer-sandbox / staging / quarantined / scheduled / orphaned) with £/month. The staging test number (…1883) is labelled **Reserved — do not release** and gets **no release-review button**.
- **Money**: "Money at a glance" cards; the £5.99 inc-VAT launch notice; highest-cost customers (≥ 50 % of allowance) from Fortress budgets. The finance section is renamed "Finance detail".
- **Operations**:
  - "Service & safety status" table, read-only.
  - Emergency controls are deliberately **not** buttons; they stay on the audited, typed-confirmation endpoints.
  - Customer search placeholder: "HCG account number, email or phone".
  - Glossary states both definitions explicitly.
- **Fixes**:
  - System-health component names and reasons are now escaped.
  - Tab switches update the URL without the browser jumping, and the page no longer scrolls to the panel on load.
- **Responsive**: at ≤ 640 px the tabs scroll horizontally, KPIs are 2×2, status rows stack, attention items stack, the Setup and Last activity columns hide, and the journey becomes vertical.

### Changed tests (deliberate contract changes)

- `tests/dashboard-consolidation.test.mjs`: active tab fill is now HCG green `var(--green)` = `#3cf07a` (was cyan `#22d3ee`).
- `tests/business-control.test.mjs`: `overviewBody` now sits in Operations. The new containers are asserted in their tabs.

## 6. What was deliberately moved out of Overview

| Was on Overview | Now |
|---|---|
| 13 "Checks" cards (numbers mapped, lifecycle anomalies, rental, pending release, paid-unclassified, non-paying access, MRR card, protected/entitled counts…) | Operations → Detailed business checks |
| Definitions glossary | Operations → under the detailed checks |
| Stripe mode / release-failure recording line | Operations → under the detailed checks |
| Legacy customer-health reasons in the attention list | Replaced by canonical exception items with the customer named |

The Overview now has 4 numbers, 5 status rows, a prioritised list and an activity feed. No engineering terms remain except where a next step needs them.

## 7. How genuine customers are separated from tests

- **Genuine paying** = `classifyCommercialStatus(...).genuinePaying`:
  - Stripe live, or Apple/Google with RevenueCat environment `production`;
  - **and** not classified internal_test / admin / reviewer / qa_automation / other_non_customer.
- Display segments map the canonical status directly:

  | Canonical status | Shown as |
  |---|---|
  | Genuine paying | Genuine paying |
  | Complimentary / trial | Complimentary / Trial |
  | Internal or test | Internal / test, or Reviewer (from the account's own classification) |
  | Store sandbox / TestFlight / App Review, Stripe test | **Sandbox** |
  | Store environment unverified | **Payment environment unverified** |

  With no current membership:
  - **Former customer** means a past paid entitlement that the same classifier would have counted as genuine.
  - Otherwise the account is shown as "Signed up, never a member".
- Genuine KPIs, protected counts, "needs attention" counts and every **celebration** come only from `genuine_paying`. Tests assert test, reviewer, sandbox, unverified and complimentary accounts never celebrate and never count.
- **Identity** is the HCG account number (`households.account_number`, migration 062). Where 062 is not applied the page says "No account no. yet". It never substitutes a Twilio number. Telephone numbers are masked in the summary.

## 8. How customer problems become visible

1. **Highlight cards** at the very top: CUSTOMER NEEDS ATTENTION (red), NEW GENUINE CUSTOMER and CUSTOMER PROTECTED (green, last 72 h, max 4). Each has an "Open customer" link.
2. **Needs attention KPI** (red when > 0), and a red count on the Customers tab, both genuine-only.
3. **HCG status → Customer protection** turns Critical when any genuine customer has a critical item.
4. **Needs your attention** lists each genuine customer by account number and email, with what is wrong, why it matters and the next step, plus an *Open customer* button.
5. **The September incident is explicit.** A new admin rule, `CALLS_ARRIVING_APP_NOT_REGISTERED`, applies when a genuine paying customer is at canonical stage `awaiting_app` while `activation_verified_at` is set, meaning forwarded calls already reach HCG. It is raised as **Critical** immediately, not after the 24 h `SETUP_STALLED` window, and replaces `SETUP_STALLED` for that customer so there is one item, not two. Sandbox accounts in the same state are not raised this way.

   This is the only attention rule the summary adds. It is derived from the canonical stage, it is labelled in code, and it changes nothing the system does.
6. **Customer detail** puts the journey first with the missing step highlighted, then "Not protected because: …" from the canonical blockers, then the existing diagnostics.

## 9. HCG branding

- Logo: the existing `public/hcg-shield.png` (also the favicon). No new logo.
- Name block: "HOME CALL GUARD" (tracked caps) / "Admin Control Centre" in HCG green.
- Palette and typeface: identical to the public website. Operational colours: green Healthy, amber Attention, red Critical, grey Not reported. Every state also has a text label, never colour alone.
- Professional rather than decorative: one gradient on highlight cards; no imagery beyond the shield.

## 10. Safety (what was not done)

- No deploy, no merge to `main`, nothing pushed except this branch.
- No database change and no migration. No provider, Stripe, Apple or Google change. No price change: the £5.99 notice is text.
- No customer contact, and no notification or email enabled.
- No number released. The reserved staging number cannot be reviewed for release from the dashboard, and no release control exists.
- No auth change. The new route uses the same `requireAuth` + `requireAdmin` as every admin route.
- No new definition of genuine, protected or financial authority.
- The Fortress controls are unchanged and the UI exposes none of them as buttons.

**Preview method, stated plainly:** screenshots come from the real page fed synthetic fixtures by a local harness. There is no local Supabase (no Docker on this machine), and logging in on staging would have meant creating an admin account there. So **authentication was not exercised in the previews**; the route's auth is covered by tests instead (§11). Nothing in the harness is reachable from the server.

## 11. Tests

Offline dummy environment (`SUPABASE_URL=http://127.0.0.1:9`, dummy keys, `NODE_ENV=test`):

| Run | Result |
|---|---|
| `tests/admin-control-centre-redesign.test.mjs` | ✓68 ✗0 |
| Full suite (`node scripts/run-all-tests.mjs`) | **198/198 files, ✓8,756 ✗0** |

- **Mutation check.** Four deliberate breakages were each caught, and every file was restored and verified byte-identical:
  - disabling the incident rule;
  - counting sandbox as genuine;
  - removing escaping from attention titles;
  - removing the reserved-number check.
- **Environmental note.** On the first full run 7 mobile files failed with `Cannot find module '../mobile/node_modules/typescript'`; this worktree had no mobile install. After symlinking the soft-launch worktree's `mobile/node_modules` (git-ignored), all 7 pass. No mobile code was changed.
- **Not exercised.** The three real-PostgreSQL suites (`*-realpg`) report 0 checks because `FC_REALPG_MODULES` was not set. This branch has no SQL or migration change.

## 12. Functionality still needing integration or decisions

| # | Item | Status / recommendation |
|---|---|---|
| D-1 | **Converge the two genuine definitions.** These still use v2 `genuine_customer` classification: Stripe MRR attribution (the "Monthly revenue" KPI), number inventory categories, the Memberships counts, usage `accountClass` and the detailed checks. | Recommend making `commercialStatus` the only rule and attributing Stripe MRR by `stripe_customer_id` → household → commercial status. Andrew's decision; until then the glossary states both. |
| D-2 | Legacy `adminCustomerHealth` / `computeProtectionStatus` still drive `/admin/api/customers/onboarding` and the diagnostics panel. | Move them onto `activationState` (lifecycle doc step D-W1). The new table already uses the canonical state. |
| D-3 | Migration 062 (account numbers) is not applied in production. | Until it is, every row says "No account no. yet". |
| D-4 | Migration 072 (ops events) is not applied. | Highlights and activity are derived from the summary meanwhile. The existing "mark seen" route is not wired into the UI. Notifications stay OFF. |
| D-5 | Migrations 064–070 (Fortress) and 071 (accounting) are not applied. | Financial protection, allowance exposure and accounting show "Not reported / not deployed" in production until applied. |
| D-6 | Delivery health is not loaded in bulk. | The summary judges "app reachable" from registration history, the same as the exception queue. The per-customer lifecycle route loads live delivery health. |
| D-7 | Refunds are not a separate figure. | Revenue is net of refunds; add a refunds line from Stripe if wanted. |
| D-8 | Background-job heartbeat does not exist. | Shown as "Not reported". A heartbeat table would make it real. |
| D-9 | Emergency-control UI (breaker reset, kill switch, holds) is not built, by design. | If wanted later: a separate screen with typed-phrase + reason forms calling the existing audited endpoints. |
| D-10 | Classification history panel needs 069. | Unchanged from v2. |
| D-11 | Release-review prototype (v2), final button disabled. | Unchanged; hidden for the reserved staging number. |
| D-12 | Live price check. | The dashboard states £5.99 inc VAT. Live Stripe and store prices were not checked or changed here. |
| D-13 | Scale. | The summary loads every household snapshot per request. Fine for the soft launch; paginate or cache before hundreds of customers. |

**STOP:** this branch is ready for Andrew's review. Do not merge or deploy without his approval. Integrate it after (or together with) the soft-launch candidate it is based on.
