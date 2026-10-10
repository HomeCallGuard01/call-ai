# Production containment hotfix: approval brief (2026-10-10)

- **Branch:** `hotfix/prod-containment-2026-10-10`, at `ea58231` (worktree `call-ai-hotfix-prod-containment`).
- **Base:** production `eb43368` (= `origin/main`). Three commits. Local only, **not pushed, not deployed**.

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

1. I push the branch and open a PR into `main`. It is a fast-forward of `eb43368`, three commits.
2. You review and merge. **Railway auto-deploys `main`.**
3. Do **not** set `HCG_LIVE_MONITORING_ENABLED` or `HCG_PROCESS_ROUTE_ENABLED`.

## Verify (about 10 minutes; nothing chargeable)

| Check | Pass |
|---|---|
| Railway log after boot | `EMERGENCY CONTAINMENT: live monitoring is OFF` |
| `GET /health` | 200 |
| `curl -X POST https://homecallguard.co.uk/process -d 'SpeechResult=test'` | **404** |
| WebSocket to `wss://homecallguard.co.uk/media-stream` | refused (no upgrade) |
| OpenAI usage page over the next 24 h | **flat** (no transcription) |
| *Optional, needs a separate GO for a live call:* one call to `…6063` from a non-contact | rings the app with **no** announcement |

## Roll back

| Option | Effect |
|---|---|
| Railway → Deployments → redeploy `eb43368` | Previous behaviour, **holes reopen** |
| Set `HCG_LIVE_MONITORING_ENABLED=true` (Railway restarts) | Screening back, **media-stream hole reopens** |
| Revert the merge on `main` | Same as the first option, kept in git history |

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
