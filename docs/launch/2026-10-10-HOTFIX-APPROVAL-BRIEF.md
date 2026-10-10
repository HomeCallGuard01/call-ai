# Production containment hotfix: approval brief (2026-10-10)

- **Branch:** `hotfix/prod-containment-2026-10-10`, at `ea58231` (worktree `call-ai-hotfix-prod-containment`).
- **Base:** production `eb43368` (= `origin/main`). Three commits. **Pushed; draft PR #52 opened 2026-10-10 (https://github.com/HomeCallGuard01/call-ai/pull/52). Not merged, not deployed.**

## Correction first

**No unauthorised OpenAI charges have been observed in production.**
- The "3 OpenAI requests" in the earlier report came from a **local** test of the unpatched production code against a stand-in OpenAI server. They show the hole is real and exploitable. They are **not** evidence that it has been used.
- To check for past abuse, look at the OpenAI usage page (by day; any transcription spend that doesn't match real calls) and the Railway logs (`media_stream_started` without a matching `/voice` call).

## What it changes (`server.js` +27 lines, behind two environment switches, both default OFF)

| Function | With the hotfix |
|---|---|
| Call delivery (trusted and unknown callers ring the app) | **Unchanged** |
| Unknown-caller **live AI screening**: transcription, scam detection, warning SMS to the customer, automatic red-line hang-up | **OFF** |
| Caller announcement "This number is monitored and protected…" | **OFF**, so no caller is told the number is protected while it isn't |
| `/media-stream` WebSocket endpoint | **Not attached.** Forged connections are refused |
| `POST /process` (legacy classifier, not used by any live call flow) | **404** |
| Everything else (sign-up, billing, numbers, contacts, app, admin) | Unchanged |

## Who loses active screening

- **Every household with an active entitlement**: their unknown callers are delivered unscreened until the hardened release is deployed.
- **Last production snapshot (6 Oct):** 36 households, 38 entitlements, 15 subscriptions, **0 genuine paying customers**. The remaining entitlements are complimentary, test, reviewer or unverified accounts.
- **Confirm the current count before approving:** admin Control Centre → genuine customers. Or approve one read-only count query.
- If any genuine customer exists, tell them that screening is paused for maintenance and that calls still reach them.

## Can legitimate screening be kept while closing the holes?

**Not safely on production code.**
- Production's `/voice` is unsigned. Anyone can create a "real" call record with any Call SID, so any gate based on the database or the Call SID can be bypassed.
- Keeping screening safely needs signed webhooks, single-use stream tokens and the Fortress. That **is** the release candidate (`launch/controlled-launch-2026-10-09`: 63 attack checks, every forged case causes 0 OpenAI calls and 0 SMS).

**Plan:**
1. Deploy the hotfix now.
2. Screening returns when the release candidate is deployed in the production window.

## Deploy (after your GO)

1. **Done 2026-10-10:** branch pushed; **draft** PR #52 into `main` (a fast-forward of `eb43368`, three commits). GitHub recorded no deployment for it, and all 163 historical deployments are commits on `main`.
2. On your deploy GO: mark PR #52 ready, then merge. **Railway auto-deploys `main`.**
3. Do **not** set `HCG_LIVE_MONITORING_ENABLED` or `HCG_PROCESS_ROUTE_ENABLED`.

## Immediate post-deployment checks (about 10 minutes)

**Security.** These requests go to our own server and cost nothing. Run them from a repo worktree, with Andrew's GO at the time:

| # | Check | Pass |
|---|---|---|
| S1 | Railway → Deployments | The running deployment is the merge of PR #52 (head `ea58231`) |
| S2 | Railway → logs at boot | `EMERGENCY CONTAINMENT: live monitoring is OFF …` |
| S3 | `curl -s -o /dev/null -w "%{http_code}\n" https://homecallguard.co.uk/health` | `200` |
| S4 | `curl -s -o /dev/null -w "%{http_code}\n" -X POST -d 'SpeechResult=test%20call' https://homecallguard.co.uk/process` | `404` |
| S5 | `node -e "const W=require('ws');const w=new W('wss://homecallguard.co.uk/media-stream');w.on('open',()=>{console.log('FAIL: open');process.exit(1)});w.on('unexpected-response',(q,r)=>{console.log('PASS: refused',r.statusCode);process.exit(0)});w.on('error',e=>{console.log('PASS: refused',e.message);process.exit(0)})"` | `PASS: refused` |
| S6 | OpenAI usage page over the next 24 h | Flat: no new transcription or chat spend |

**Call delivery:**

| # | Check | Pass |
|---|---|---|
| D1 | Passive. Railway logs on the next real inbound calls | `MONITORING PAUSED (emergency containment)` appears; no `CALL DELIVERY` errors |
| D2 | Passive. Twilio console → Monitor → Calls | Inbound calls to HCG numbers have a **completed** `client:` child leg, as before the deploy |
| D3 | *Active, separate GO (about 1p):* Andrew calls `…6063` from a phone that is **not** a contact | The app rings; **no** announcement |
| D4 | *Active, separate GO:* a call from a trusted contact | Rings normally |
| D5 | Admin `/admin/business` | Loads; numbers unchanged |

## How to read the customer count (required before the deploy GO)

My read-only production query was refused by the session's permission rules, so use either:

1. **Admin dashboard:** sign in at `https://homecallguard.co.uk/admin/business`.
   - **Business** tab: "**Real paying customers**" (genuine paying).
   - **Operations** tab: "**Active paid customers**" and "**Active protected households**".
   - Every household with an active entitlement (paid, complimentary or trial) currently gets screening, and loses it under the hotfix.
2. **Count-only script** (prints counts, never names, emails, numbers or IDs):
   `! node /private/tmp/claude-501/-Users-ad-call-ai/0afee8f8-a83e-4291-ad99-d5d809e1eb7d/scratchpad/prod-customer-count.cjs`

Caveat: production has no test-account labels and no store-environment field. Any live Stripe purchase you made yourself, and any TestFlight grant, shows as paying.

## Not closed by this hotfix

- **Number purchases** from a sandbox/TestFlight RevenueCat grant (about £1 each).
- Purchases from a live Stripe checkout.

Both need signed or authenticated webhooks, not anonymous internet traffic. They are covered by C1 (archive the live Stripe price) and C2 (remove the iOS IAP from sale).

## Recovery that does NOT reopen the paid endpoints

**Set the provider hard limits (C4 OpenAI, C5 Twilio) before deploying**, so even the last resort is bounded.

| Symptom after the merge | Action | Endpoints stay closed? |
|---|---|---|
| Deploy fails to boot, or `/health` is not 200 | Railway → service → **Restart**. If that fails, redeploy the previous successful hotfix deployment | Yes |
| Calls not delivered, and the hotfix's `/voice` change is suspected | Merge the **R2 recovery variant** `hotfix/prod-containment-r2-2026-10-10` (`9482f92`, local; pushed on request). R2 keeps `/process` at 404 and `/media-stream` detached, and its **`/voice` handler is byte-identical to `eb43368`** (verified by diff). Production suite 105/106; boot test passes | Yes |
| R2 also fails to deliver calls (the cause is not the hotfix) | Only then redeploy `eb43368`, with C4/C5 already set; tell Andrew immediately | **No** (bounded by the provider hard limits) |
| `HCG_LIVE_MONITORING_ENABLED` or `HCG_PROCESS_ROUTE_ENABLED` set by mistake | Remove the variable. **Never set either until the release candidate is deployed** | — |

## Tests

- Production's own suite: **105/106** files. The failure is the known symlink-only `expo prebuild` check.
- New boot test against the real `server.js`:
  - 0 OpenAI requests from unsigned `/process`;
  - forged stream refused;
  - an entitled household's unknown call is still delivered, with no stream and no announcement;
  - the switch restores the previous behaviour exactly.
- The same test against unpatched `eb43368` fails the containment checks.

## Interaction with the release deploy

When the release candidate is merged later, `main` will contain these three commits. Merge `main` into the release branch first and take the release branch's `server.js`; its protections supersede the switch.
