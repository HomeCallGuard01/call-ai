# Launch Feature Matrix — Home Call Guard Mobile App

STATUS: Proposed for review. No architecture changed, no code written. Goal: the smallest V1 app that delivers an excellent first customer experience, launched as fast as possible without compromising quality — everything below is judged against that bar, not against "would this be nice to have eventually."

## 1. Must have for V1 launch

| Feature | Screens | Why it's a launch blocker |
|---|---|---|
| Register / confirm email / login / forgot / reset password | A1–A7 | No account system, no product. |
| Protection Status home screen | C1 | The entire reason the app exists — without it there's nothing to open the app for. |
| Membership subscribe (Stripe Checkout handoff) | B2 | Can't have "protected" without a paid entitlement; reuses the existing, already-live Checkout flow as-is — near-zero incremental build cost. |
| Device/provider picker + activation instructions | B3, B4 | The core value-delivery step. Without activation, the product does nothing regardless of how polished the rest of the app is. |
| Activation verification (server-checked) | B5 | Genuinely the highest-value differentiator identified in Phase 1 — but see the fallback note below if timeline pressure is severe. |
| Manual add / edit / delete trusted contact | C2, C3 | Core to the screening logic itself (trusted numbers must exist somewhere) — and this path needs **zero new backend work**, reusing the existing `/contacts` endpoints exactly as they are today. |
| Activity list (no drill-down) | C4 | Answers "is this working" — the second most important question after "am I protected," and a plain list is a small build. |
| Manage Membership (Billing Portal handoff) | D1 | Customers must be able to cancel or fix a payment method without phoning support; reuses the existing `/billing/manage-membership` endpoint as-is. |
| Support — contact details only (no FAQ yet) | D3 (partial) | A working phone/email link costs almost nothing and is essential for a security product; the FAQ content itself is not essential on day one (see Should Have). |
| Legal links | D4 | Required for app store approval and for compliance — trivial effort, just links to pages that already exist. |
| Account hub | C6 | Simple navigational parent for the above — near-zero cost once they exist. |
| Offline handling / session-expiry handling | E3, E4 | Not a "feature," basic production-readiness — any app needs this regardless of scope. |
| The one-line "if you're on the phone with someone helping you, use speaker or another phone" copy in B4 | B4 | Costs one sentence, prevents a real setup failure identified in the persona review — no reason this waits for a later release. |

**Fallback worth stating explicitly:** if timeline pressure becomes severe, B5's automatic verification could ship V1 as a simple customer self-report ("I've done this") with real server-side verification added as the very first post-launch improvement. This is the one item on this list where a lower-fidelity version is a legitimate, honest trade — flagging it rather than silently downgrading it.

## 2. Should have shortly after launch

| Feature | Screens | Why it waits, and why not much longer |
|---|---|---|
| Native contact picker (tap → select from device contacts) | B1 (soft-ask), B6–B8, E1 | The single largest discrete piece of *new* work in the whole spec (new native permission integration, a custom multi-select UI, a new bulk-upload endpint) — and the app is fully usable without it, since manual entry (already Must Have) covers the same underlying need. Real value, but not required to open for business. |
| Call detail drill-down with plain-language reasoning | C5 | Builds trust and depth once the customer already trusts the basic list is working — not required for the minimal loop to deliver value. |
| Push notifications + notification preferences | E2, D2 | Already flagged in the roadmap as needing real device credentials and hands-on testing that can't be simulated — a natural fast-follow, not a blocker, since the Activity tab already surfaces the same information when the customer opens the app. |
| Sign in with Apple / Google | A3 | A real conversion improvement, but email/password (Must Have) already fully covers the need — worth adding once basic auth is proven live, not before. |
| FAQ content in Support | D3 (remainder) | Better to write real FAQs from actual early support tickets than guess at them pre-launch — ship the human contact channel first, layer in FAQ content once you know what people actually ask. |
| Deeper activation troubleshooting content in B5 | B5 | The core pass/fail check is Must Have; the richer "here's probably why it failed" branching can be refined once real failure patterns exist. |

## 3. Future enhancement

| Feature | Why it's genuinely later, not just deprioritised |
|---|---|
| Family/shared visibility (an adult child checking a parent's status from their own login) | Flagged in the persona review as needing a real product/data-model decision (a genuine "family member" access role), not a quick UI add — deliberately deferred until the core single-user app is proven, then designed properly rather than bolted on. |
| CallKit-style native call handling | Already explicitly rejected for v1 in `APP_DECISION_007` — a different, much larger architectural project, not a mobile-app feature. |
| Android `CallScreeningService` pre-ring blocklist layer | A genuinely different, complementary capability (metadata-only, pre-answer) to the core conversational screening — worth exploring once the core product is live, not part of it. |
| Text-to-speech / audio narration for activation instructions | A real accessibility enhancement identified in the persona review, but additive polish, not a blocker to a working product. |
| A shareable "assisted setup" link for remote family help | Goes beyond the one-line Must Have copy fix into a genuinely new capability — worth designing once real usage shows how often this scenario occurs. |
| Pagination/infinite-scroll for long activity history | Only matters at scale — ship a simple recent-history list first, add this only if real usage data shows it's needed. |
| Dedicated activity/contacts read endpoints (separate from the aggregate dashboard call) | Explicitly noted in the spec as "build only if the aggregate proves too heavy" — don't build ahead of evidence. |

**Deliberately not planned at all, at any stage** (distinct from "future" — this was already decided against, not just deferred): granular per-event notification settings beyond the two categories in `APP_DECISION_002` — intentionally rejected as unnecessary complexity for this audience, not a backlog item.

## 4. Recommend staying on the website, not rebuilt into the app

- **Admin dashboard** — already decided (`APP_DECISION_001`): permanently web-only, not an app feature at any stage.
- **Billing Portal (payment method, invoices, cancellation)** — already correctly designed as a Stripe-hosted web handoff (D1), not a native rebuild. No change needed, just confirming this is the right call to hold to.
- **Terms/Privacy** — already correctly a web-page link-out (D4). Same, no change needed.
- **New recommendation: FAQ/help content** — rather than building native FAQ UI in the app at all, consider making D3 a simple deep-link to a web help centre page. Cuts one more piece of native UI from V1, and help content can then be updated without an app-store release.
- **New recommendation: the activation instruction text itself** (the specific carrier codes and caveats in B4) — this content will need correcting over time as carriers change processes (Sky/Virgin's £2.50 add-on, for instance, is exactly the kind of detail that goes stale). Recommend sourcing this copy from a web-served page or simple CMS-backed endpoint the app fetches, rather than hardcoding it into the app bundle — keeps the *decision flow* (which provider did you pick) native and fast, while making the *text* editable without waiting on app-store review.

## What this leaves as the actual V1 app

Auth (email/password only) → Subscribe → Activate (manual verification fallback available) → Add contacts manually → see status, activity list, and manage membership. No native contact picker, no push, no call-detail drill-down, no FAQ content, no family sharing. Genuinely small, genuinely complete as a first product — every screen in it maps to something the customer cannot get value without.

Stopping here for your review and approval before Phase 2 begins.
