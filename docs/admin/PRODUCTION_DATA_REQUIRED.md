<!--
STATUS (2026-10-01): open list. Nothing below was read from production in the v5 session: production reads were not attempted, and no permission was bypassed.
-->
# Dashboard items that need production data

Everything on `feature/admin-control-centre-v2` is tested on pure functions with fixtures, plus the full repository suite. The items below can only be confirmed against production. Each one is answered by opening the deployed dashboard as an admin, or by an authorised read-only query.

| # | Question | Where it shows once deployed | Why it matters |
|---|---|---|---|
| 1 | Real monitored minutes per household and month to date, plus the busiest household | Operations → Usage & cost safety | Sizes the uncapped exposure (cost-safety launch gate) |
| 2 | How many approved calls have no recorded outcome (the known `CALL DURATION RECORD FAILED` gap) | Usage signal "Approved calls with no recorded outcome" | Unmeasured minutes are billed but invisible |
| 3 | How many connected unknown calls have no monitoring record | Usage signal "Connected unknown calls with no monitoring record" | Would mean protection silently didn't run |
| 4 | Whether any call has reached 60+ min, or the 30-min monitoring limit | Usage signals | Tests the "4 h Twilio default" exposure in practice |
| 5 | Real peak concurrency, against the 200-stream cap | Usage → peak simultaneous | Confirms whether the cap's default is sane |
| 6 | Whether `MONITORING_MAX_DURATION_MINUTES`, `MEDIA_STREAM_MAX_CONCURRENT_STREAMS`, `RAPID_ABUSE_*` or `BUSINESS_FAIR_USE_*` are overridden in Railway | Usage → Limits in this build (Value / source column) | The dashboard shows the running config, which no fixture can know |
| 7 | Whether `calls` has more than 1000 rows in a month (and therefore whether `callStats.js` on main already undercounts) | Compare Operations → Call activity MTD with Usage → month to date | Decides whether the main-branch fix is urgent |
| 8 | (carried from v3/v4) Classification of household `87fdd35a`, live Stripe totals, the remaining Twilio inventory after the 2026-09-30 release of 10 numbers | Overview, Numbers, Money | Unverified since 27 Sep |

Not answerable from the database at all (logs or provider consoles only): stream refusals at the cap, transcription/OpenAI failures, alert e-mails as sent, forged /media-stream attempts, and Twilio minutes for calls rejected before logging.
