# Containment evidence capture checklist (WS1, 2026-10-10)

**For:** Andrew, while doing the console steps in `2026-10-09-PROVIDER-CONTAINMENT-CHECKLIST.md` §2.
**Status:** checklist only. Nothing here has been done, and no console or API has been opened.
**Evidence folder:** `docs/security/evidence/provider-config-2026-10-DD/`. Use the date of the day you do the work. Commit screenshots and exports only after reading the "never capture" rules.

## Rules for every capture

- **Never capture:** a secret value (auth token, API key secret, webhook signing secret), a full card number, a customer's phone number or email. Crop or blur before saving. Showing the last 4 characters is fine.
- **Name every file** `NN-provider-control-YYYYMMDDTHHMMZ.png`, for example `07-twilio-messaging-geo-20261010T1412Z.png`.
- **The screenshot must show** the browser address bar or the console breadcrumb, the account or project name, and the clock (system clock visible, or an in-page timestamp).
- **Record one line per step** in `INDEX.md` in the evidence folder, with step, file, UTC time, and what it shows. Use the table template at the bottom of this file.

## A. OpenAI

| # | Do | Capture | PASS when the capture shows |
|---|---|---|---|
| A1 | Project (the one holding production `OPENAI_API_KEY`) → Settings → Limits → Spend → set **L**, turn on **Enforce a hard limit** | `01-openai-project-limit` | Project name; the amount L; "Enforce" on |
| A2 | Organization → Limits → Spend → set ≥ L, enforce | `02-openai-org-limit` | The org amount; enforce on |
| A3 | Settings → Billing → Auto-reload off, or a monthly cap | `03-openai-autoreload` | Auto-reload off, or the cap amount |
| A4 | Project → API keys | `04-openai-keys` | Key names and last 4 only. Permissions = restricted, if already done. No Admin key used by Railway |
| A5 | Limits → Spend alerts | `05-openai-alerts` | Threshold(s) |

## B. Twilio

| # | Do | Capture | PASS when the capture shows |
|---|---|---|---|
| B1 | Billing overview: read only | `06-twilio-billing-type` | **Pay-as-you-go** (if Invoiced: STOP and tell the launch lead) and the balance |
| B2 | Billing → Auto-recharge **OFF** | `07-twilio-autorecharge` | Off. If the console refuses, capture the refusal message |
| B3 | Add funds only up to **B** | `08-twilio-balance` | Balance ≤ B |
| B4 | Messaging → Settings → Geo permissions → **United Kingdom only** → Save | `09-twilio-messaging-geo` | Only GB ticked, after Save. (The API cannot read or change this, so this screenshot is the only evidence) |
| B5 | Voice → Settings → Geo permissions → **all off, GB included** | `10-twilio-voice-geo` | Every region unticked. Also capture Monitor → Events filtered to geo-permission changes, last 90 days (`11-twilio-geo-events`) |
| B6 | Voice → Settings → General → 24-Hour Maximum Call Duration **disabled** | `12-twilio-max-duration` | Disabled (so the 4 h ceiling applies) |
| B7 | TwiML Bins → Create `hcg-fallback-reject`. Paste **exactly** the body of `scripts/production/twiml-bin-reject.xml`: `<?xml version="1.0" encoding="UTF-8"?>` then `<Response><Reject/></Response>` | `13-twilio-bin` | The Bin name, the body, and the Bin URL (`https://handler.twilio.com/twiml/EH…`). Copy the URL into a text note, not a secret |
| B8 | For **every** active number: Phone Numbers → number → Voice → "Primary handler fails" → Webhook → the Bin URL → Save. **Do not change "A call comes in".** | `14-twilio-number-<last4>` (one per number) | "A call comes in" is still `https://<app>/voice`; "Primary handler fails" is the Bin URL |
| B9 | Voice → TwiML Apps → the Voice SDK app → Fallback URL = the Bin URL | `15-twilio-twiml-app` | The fallback field |
| B10 | Usage triggers (email notification): `totalprice` daily (about 5× a normal day), `totalprice` monthly, `sms-outbound` daily (about 20), `calls-outbound` ≥ 1 daily, `phonenumbers` = count + 2 | `16-twilio-triggers` | All five, with their values. Record each `UT…` SID in INDEX.md (not a secret) |
| B11 | Billing → Low-balance email at about 1 week of spend | `17-twilio-low-balance` | Threshold |
| B12 | Number inventory export (Phone Numbers → Active → export, or a screenshot) | `18-twilio-inventory` | Count, with numbers masked to last 4 |

## C. Stripe

| # | Do | Capture | PASS when the capture shows |
|---|---|---|---|
| C1 | Product catalog → the live product → £4.99 Price ⋯ → **Archive** | `19-stripe-price-archived` | The Price marked Archived |
| C2 | Payment Links: deactivate any that use it | `20-stripe-payment-links` | None active |
| C3 | Developers → Webhooks | `21-stripe-webhooks` | One production endpoint and its event list. **No signing secret visible** |
| C4 | Developers → API keys | `22-stripe-keys` | Key names and last 4 only; unused keys expired |
| C5 | Radar → Rules | `23-stripe-radar` | Plan name; default rules on |
| C6 | Settings → Communication preferences → disputes / failed payments email on | `24-stripe-notifications` | Toggles on |

## D. App Store Connect (only if iOS is excluded from the cohort)

| # | Do | Capture | PASS |
|---|---|---|---|
| D1 | The IAP product → Remove from sale | `25-asc-iap` | "Removed from sale" |

## E. Independent read-back (after the window opens, needs a separate GO)

When a **restricted, read-only** Twilio API key exists, the launch lead can run the read-back:

```
node scripts/production/verify-twilio-config-readonly.mjs --account AC… --app-url https://<app> --fallback-url <Bin URL>
```

- With no flags it is a dry run: it prints the GETs it would make and nothing else.
- `--execute` reads B8, B9, B5 and B10 back through the API.
- It refuses the master auth token.
- Save its output as `26-readback.txt`.
- It has **not** been run. It has been tested only against a stub.

## INDEX.md template

```
| Step | File | UTC | Shows | By |
|---|---|---|---|---|
| A1 | 01-openai-project-limit-20261010T1402Z.png | 2026-10-10T14:02Z | project hcg-prod, L=$__, enforce ON | Andrew |
```

Owner of every step: Andrew. The launch lead reads INDEX.md before D1 of the deploy window.
