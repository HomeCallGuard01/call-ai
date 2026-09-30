# HCG: architecture, economics and catastrophic-risk review

Research, architecture and financial-safety review, 2026-10-01 (overnight).

- **Nothing was deployed, merged, or changed in production, forwarding or customer accounts. No handset tests. No testing against production.**
- Security findings come from repository review of `origin/main` (eb43368) and safe external research only.
- Models: `architecture-model.js`, output in `ARCHITECTURE_MODEL_OUTPUT.md`. Last night's `portfolio-model.js` and `DECISION_PAPER.md` are **partly superseded** (see §2.3).

**Evidence labels:**

| Label | Meaning |
|---|---|
| **PROVEN** | Verified directly (code, official docs, invoices) |
| **STRONG** | Strong evidence |
| **LIKELY** | Likely |
| **UNCONF** | Unconfirmed |
| **ASM** | Assumption |

**Price labels:** CONFIRMED HCG INVOICE · CURRENT OFFICIAL PUBLISHED PRICE · PROVIDER QUOTE REQUIRED · ASSUMPTION.

---

## 0. Urgent: act before anything else (probably live on main)

**Unauthenticated `/media-stream` turns HCG into an SMS cannon and an OpenAI bill generator.**
- **Evidence (STRONG, code):**
  - `services/liveMonitoring/mediaStreamHandler.js` takes `householdId`, `toNumber` (warning-SMS destination) and `protectedNumber` (SMS sender) from the WebSocket `start` message's `customParameters` (lines ~278–294).
  - `server.js` only *sets* these parameters for genuine Twilio streams; nothing re-derives or verifies them server-side.
  - The Twilio signature check on `/media-stream` is shadow-only (logs, never rejects).
- **The attack:** a script opens a WebSocket, sends a forged `start` with `toNumber` = any number and `protectedNumber` = a real HCG number (these are public), then streams recorded scam-like audio.
  - HCG pays OpenAI transcription.
  - riskMonitor sends an **HCG-branded scam-warning SMS from HCG's Twilio number to the attacker-chosen number**.
- **Bound today:** only the 200-concurrent-stream cap (main). With streams of about 20 seconds, that's ~36,000 forged streams an hour (ASM).
  - Up to **~£1,500/hour of UK SMS** + **~£57/hour of transcription**.
  - More if Twilio SMS geo-permissions allow international or premium destinations (UNCONF; Andrew must check the Twilio console).
  - Plus harassment and brand damage, and a likely Twilio suspension for spam.
- **Is it being exploited?** Not assessed; no production access was used.
- **Minimum fix (not implemented tonight):**
  1. Reject `/media-stream` connections whose Twilio signature fails (it's already computed in shadow mode).
  2. Never take SMS destination, sender or household from the stream. Look them up server-side from a reservation created by a signed `/voice`. The unmerged `feature/financial-safety-hard-limits` already refuses transcription without a reservation, but still reads `toNumber` from the stream.
  3. Twilio SMS geo-permissions: UK only.
- **RELEASE BLOCKER, and a candidate for a hotfix decision now.**

---

## 1. Executive findings

1. **HCG as deployed today does not meet the absolute requirement. PROVEN.** At least three independent paths to unbounded or very large cost are stopped by nothing outside the attacker's control:
   - forged media streams (§0);
   - inbound call floods: Twilio has no configurable inbound concurrency or spend cap for approved accounts;
   - backend-credential compromise: the app holds the **master Twilio auth token**, which can re-enable international dialling through the Dialing Permissions API and place calls or buy numbers without limit.
2. **Twilio offers no spend cap. PROVEN.** Its only hard stop is a **prepaid balance with auto-recharge off**.
   - It is account-wide: subaccounts share the parent balance, and parent suspension suspends all subaccounts.
   - Reaching it **suspends every customer at once**.
   - Usage triggers only notify.
3. **Under unconditional forwarding (**21*), no architecture can both keep a customer's calls flowing and stop HCG paying for them. PROVEN, structural.** The only financially safe states are:
   - provider-enforced **capacity** bounds (a SIP carrier's channel count), where cost is bounded but excess calls fail;
   - network-side routing (Option D), where the network fails open to normal delivery and HCG's cost stops.
   This is an architectural deficiency of the forwarding model. §8 states it formally.
4. **Option B (free-inbound UK SIP → Twilio BYOC → existing Voice SDK) is the lowest-change route to *bounded* inbound exposure (STRONG).** Its average cost is about the same as today's billed Twilio (£3.38 vs £3.46 per subscriber, central mix). Its value is:
   - containment: the carrier's channel cap bounds a flood to ~£15/hour at 22 channels;
   - a hedge against Twilio re-pricing HCG to list rates, under which today's architecture costs £6.34 per subscriber (central) and B costs £4.27.
   B **does not** fix the backend-credential outbound-fraud risk. That needs Twilio credential isolation (§7).
5. **HCG-owned call delivery (Option C) is not an incremental change (STRONG).** It means becoming a communications platform (§4). With honest fixed ops and infrastructure costs (ASM), it loses money below ~2,500 subscribers and reaches Option A/B margins only around ~10,000. **Last night's "A4 ≈ £2.7/sub" figure omitted staff/on-call and multi-region cost and is withdrawn.**
6. **Option D (network-side selective routing) is the only architecture that can meet all five requirements, including safe failure (LIKELY), but it is entirely unconfirmed.** No provider has confirmed capability or price.
7. **Security is a launch gate and currently FAILS.** Beyond §0:
   - unsigned `/voice`;
   - master token in the backend;
   - no rate limiting on any public endpoint (`/api/v1/register` included);
   - admin access by database role with no MFA; a compromised admin can mint unlimited complimentary invites, and each redemption buys a Twilio number;
   - the Voice SDK token carries an *outgoing* grant, safe only if the TwiML App is configured as the code comment claims (UNCONF).
8. **Overall: no GO.** Gates 2 (containment), 3 (security) and 5 (safe failure) FAIL; the rest are UNPROVEN (§11).

## 2. New discoveries (since the 2026-09-30 paper)

### 2.1 Pricing
- **Twilio UK list prices vs HCG's billed rates. PROVEN, twilio.com/en-us/voice/pricing/gb.**

  | Item | List price | HCG billed |
  |---|---|---|
  | Local number | **$3.50/mo** | £0.869 |
  | Inbound | **$0.0100/min** | £0.00756 |
  | Voice SDK | $0.0040/min | £0 |
  | BYOC | $0.0040/min each direction | — |
  | SIP interface | $0.0040/min | — |
  | Media Streams | $0.0044/min | — |

  HCG's billed rates are below list. **Why is UNCONF** (legacy pricing, promotion, account-specific?). If Twilio moves HCG to list, today's architecture becomes loss-making at every price below £9.99 (central mix).

### 2.2 Provider controls
- **Twilio (PROVEN, help.twilio.com):**
  - no hard spend cap;
  - prepaid balance → suspension at $0 (calls in progress can run negative);
  - auto-recharge refills up to $2,000 per refill;
  - subaccounts share one balance;
  - trial/unapproved accounts are limited to 2–5 concurrent calls, approved accounts are unlimited;
  - geo-permissions are configurable, including a high-risk block, but **the same credentials can change them by API**;
  - webhooks can use **HTTP Basic/Digest auth** instead of the auth-token signature;
  - restricted API keys exist but **cannot mint Voice SDK Access Tokens**.
- **OpenAI (STRONG):** monthly and project budgets are notification-only. The only hard stop is **prepaid credit with auto-recharge off** (org-wide).
- **Supabase (PROVEN, docs):** the Pro spend cap blocks overages.
- **Railway (PROVEN, docs):** the hard limit takes every workload offline.

### 2.3 Correction
- Last night's A4 omitted fixed operations (on-call, multi-region, monitoring).
- With £4,000/month ops (ASM) and £600 per 1,000 subscribers infrastructure (ASM), Option C costs **£6.98/sub at 1,000 subs** (not £2.76).
- Treat every Option C figure as an assumption-driven range.

## 3. Four architectures

### 3.1 Option B leg by leg (per connected minute, GBP; FX 0.79 ASM)

| Leg | Provider | Direction | £/min | Fixed | Label |
|---|---|---|---|---|---|
| Caller → customer's mobile → forwarded to HCG DDI | Customer's MNO | Forward (customer outbound) | Customer tariff | — | ASM (in most post-pay bundles; PAYG may pay) |
| UK SIP DDI receives call | Sipflex / sipgate (aql, Magrathea: QUOTE) | Inbound | £0.00 | £2.00/number + £1.00/channel | PUBLISHED (volume terms: QUOTE) |
| Carrier → Twilio BYOC | Twilio | Into Twilio | £0.00316 | — | PUBLISHED |
| Twilio SIP interface, if *also* applied to BYOC calls | Twilio | Inbound SIP | £0.00316 | — | PUBLISHED price, applicability QUOTE |
| Twilio → app (`<Dial><Client>`) | Twilio Voice SDK | To client | £0 billed / £0.00316 list | — | INVOICE / PUBLISHED; continuation for BYOC calls QUOTE |
| Media Stream (monitored only) | Twilio | Fork | £0.00333 billed / £0.00348 list | — | INVOICE / PUBLISHED |
| Transcription (monitored only) | OpenAI | API | £0.00474 | — | PUBLISHED |
| Greeting | Twilio | Per unknown call | £0.0006 | — | INVOICE |
| VAT on supplier charges | — | — | Reclaimable if VAT-registered | — | ASM |

**Trusted minute:**

| Architecture | Twilio billed basis | Twilio list basis |
|---|---|---|
| A (today) | £0.00756 | £0.01106 |
| B | £0.00316 | £0.00632 |
| B, if Twilio also charges the SIP interface | £0.00632 | £0.00948 |

**Can HCG do B?**

| Step | Question | Status |
|---|---|---|
| 1 | UK inbound from a non-competing carrier | PUBLISHED offers exist; volume terms QUOTE |
| 2 | BYOC into Twilio | PUBLISHED product. HCG hasn't configured one; SBC/carrier interop UNCONF |
| 3 | Existing backend | LIKELY: `/voice` receives BYOC calls the same way, only the `To` format differs |
| 4 | Existing Voice SDK | LIKELY: `<Dial><Client>` is independent of the inbound leg |
| 5 | Lower trusted per-minute cost | Only on the list basis; on today's billed basis ~equal to A. QUOTE |

### 3.2 Comparison

| | A Twilio today | B SIP + BYOC + Twilio SDK | C SIP + HCG-owned delivery | D Network selective routing |
|---|---|---|---|---|
| Trusted £/min | £0.00756 billed (£0.0111 list) | £0.00316–0.00948 | ~£0.00007 bandwidth (ASM) | £0 to HCG |
| Monitored extra £/min | £0.0081 | £0.0081 | £0.0048 | £0.0048 |
| Fixed per sub | £0.87 billed (£2.77 list) | £2.00 number + channels | £2.00 + infra £0.60 (ASM) | Network fee (QUOTE) |
| Fixed platform | ~0 | ~0 | £4k+/month ops (ASM) | Same as C (for unknown calls) |
| Cost/sub, central, 1k subs | £3.46 billed / £6.34 list | £3.38 / £4.27 | £6.98 (1k) → £3.38 (10k) | £2.25 + fee (2.5k) |
| iPhone / Android | ✓ / ✓ (PROVEN in use) | ✓ / ✓ (LIKELY) | Must build (§4) | ✓ / ✓, no app for trusted (LIKELY) |
| Keeps customer's number | ✓ (forwarding) | ✓ (re-point forwarding to new DDI) | ✓ | ✓ (N1/N2), or port (N3 MVNO) |
| Existing HCG code kept | ✓ | Most (LIKELY) | Voice SDK replaced; app delivery rewritten | Backend yes; routing rebuilt |
| New infrastructure | — | Carrier + BYOC trunk | SBC, SIP proxy, media, TURN, push, multi-region | Carrier integration + C or B stack |
| Development effort | — | Weeks (ASM) | 9–15 engineer-months + 24/7 ops (ASM) | Depends on carrier; months |
| Operational complexity | Low | Medium | **Very high** | Medium–high |
| Reliability risk | Proven push/SDK issues (28 Sep incident) | + carrier/BYOC interop | **Highest** | Carrier-dependent; trusted path is native |
| Security risk | High (master token, §0) | High unless Twilio credentials isolated | Owns SIP attack surface; no Twilio outbound risk | Lowest for trusted calls |
| Financial-abuse risk | **Unbounded** (flood + credentials) | Flood bounded by channels; credential risk remains | Bounded (channels + fixed infra + prepaid AI) | Bounded |
| Max exposure (§5) | Unbounded | Bounded *if* §7 credential isolation holds | Bounded | Bounded |
| Independent hard limits | Only a global prepaid balance (outage) | Carrier channels + prepaid | Carrier channels, fixed infra, prepaid AI | Network default + channels |
| Fail state (HCG down) | Customer's calls fail | Calls fail (or carrier voicemail) | Calls fail (or carrier voicemail) | **Network delivers normally** |
| Provider dependencies | Twilio | Carrier + Twilio | Carrier + Apple/Google push | MNO/MVNE (+ B or C stack) |
| Confirmation needed | Twilio pricing stability | Carrier volume terms; BYOC charges; SDK leg; per-DID channel caps | Carrier; build estimate | **Everything** (capability + fee) |

**Verdict:**
- **A: reject** as a launch architecture. It fails #4/#5 (PROVEN).
- **B: acceptable only with §7 credential isolation** and per-DID channel limits (UNCONF).
- **C: not for launch.**
- **D: target**; pursue in parallel.

## 4. What "HCG-owned call delivery" (Option C) really means

To remove the Twilio Voice SDK, HCG must build **and run 24/7**:

| Area | Components |
|---|---|
| **Signalling** | SIP proxy/registrar (Kamailio or OpenSIPS), user authentication and registration, per-device credentials, TLS certificates, anti-flood and rate limiting, fail2ban-style SIP scanning defence (UK SIP endpoints are scanned continuously) |
| **SBC** | Topology hiding, carrier interconnect, codec negotiation, SRTP, SIP normalisation |
| **Media** | RTP relay/media server (rtpengine/FreeSWITCH), jitter buffers, transcoding, **audio fork to monitoring**, recording controls |
| **NAT traversal** | STUN, **TURN clusters** (bandwidth-heavy, abuse-prone), ICE; mobile networks behind CGNAT |
| **WebRTC or native SIP client** | An in-app SIP/WebRTC stack for iOS and Android (Linphone SDK with GPL or commercial licence, PJSIP, or react-native-webrtc + SIP.js), echo cancellation, audio session handling |
| **iOS** | PushKit VoIP pushes: every push **must** be reported to CallKit or iOS terminates the app and can stop delivering pushes. CallKit UI, audio session activation, terminated/background launch, Focus/Do-Not-Disturb, Bluetooth/CarPlay routing |
| **Android** | FCM high-priority data messages (Doze, app standby buckets, OEM battery killers), self-managed `ConnectionService`, full-screen-intent permission (already an HCG issue), foreground-service rules per Android version |
| **Call state** | Distributed call state, reconnection, multi-device, simultaneous-call handling, missed-call notification |
| **Security** | Encryption (TLS/SRTP), credential rotation, SIP fraud monitoring, DDoS protection, APNs and FCM key custody |
| **Resilience** | At least 2 regions, failover, geographic DNS, carrier redundancy (2 carriers), health checks, monitoring and alerting, capacity planning |
| **Operations** | 24/7 on-call (a missed page means customers miss calls), incident response, carrier fault handling, Ofcom obligations as a provider of number-based services (UNCONF scope) |

**Conclusion (STRONG):** this is HCG becoming its own communications platform, not an incremental change. It is sensible only at scale (≥ ~10k subscribers, ASM), or bought as a white-label platform from a non-competing provider.

## 5. Complete cost model (portfolio economics: is the business profitable?)

Categories:

| Code | Category |
|---|---|
| A | Trusted transport |
| B | Unknown transport, greeting, SMS |
| C | AI/streaming |
| D | Fixed subscriber |
| E | Payment |
| F | VAT (both deducted from revenue) |
| G | Infrastructure/ops |
| H | Fraud contingency (£0.10, ASM) |
| I | Extreme users |

Mixes (ASM, per 1,000 subscribers):

| Mix | Low | Normal | High | Extreme | Targeted |
|---|---|---|---|---|---|
| Central | 33% | 44% | 15% | 4% | 4% |
| Stress | 10% | 35% | 30% | 15% | 10% |

**Twilio billed basis:**

| Architecture | Mix | Total/sub | Margin at £4.99 / £5.99 / £6.99 / £7.99 / £9.99 |
|---|---|---|---|
| A | Central | £3.46 | 4 / 18 / 28 / 36 / 46% |
| A | Stress | £5.89 | −54 / −31 / −14 / −1 / 17% |
| B | Central | £3.38 | 6 / 20 / 29 / 37 / 47% |
| B | Stress | £4.64 | −24 / −6 / 8 / 18 / 32% |
| C, 1k subs | Central | £6.98 | −81 / −53 / −32 / −17 / 4% |
| C, 10k subs | Central | £3.38 | 6 / 20 / 29 / 37 / 47% |

**Twilio list basis:**

| Architecture | Mix | Total/sub | Margin at £4.99 / £5.99 / £6.99 / £7.99 / £9.99 |
|---|---|---|---|
| A | Central | £6.34 | −65 / −40 / −21 / −8 / 12% |
| B | Central | £4.27 | −16 / 2 / 14 / 23 / 36% |

**Option D:**
- HCG-side cost at 2,500 subs: £2.25/sub **plus the network fee** (QUOTE).
- Max affordable fee at 40%: **£0.11 (£5.99) / £0.52 (£6.99) / £0.92 (£7.99) / £1.73 (£9.99)**. At 2,500 subs HCG's ops cost dominates; the ceiling rises with scale.

**Reading (STRONG):**
- On current billed rates, no architecture gives a **40% margin below ~£7.99** with a central mix.
- Every architecture except a scaled C or D needs **~£9.99** to survive the stress mix.
- The real usage distribution is still unmeasured (0 genuine paying customers).

Portfolio averaging is **not** used anywhere as the safety mechanism.

## 6. Catastrophic financial exposure (can the business survive?)

"Stopped by" means a control **outside the attacker's reach**. All figures are illustrative (ASM parameters, not ceilings).

| # | Attacker | Arch | Attack | Stopped by (independent) | Max exposure | Blocker? |
|---|---|---|---|---|---|---|
| X1 | External, no credentials | Current | Forged `/media-stream` → SMS + transcription (§0) | Nothing except a global Twilio/OpenAI prepaid balance (if recharge off: UNCONF) | ~£1.5k/h UK SMS + £57/h AI; unbounded in time | **YES** |
| X2 | External | A | Inbound flood, 500 concurrent unknown calls | Nothing provider-side | **£469/h**, unbounded in time | **YES** |
| X3 | External | B | Same flood | Carrier channel cap (portal-only) | **£15/h** at 22 channels; excess calls busy (shared-fate) | No, if per-DID caps exist |
| X4 | External | C / D | Same flood | Channels + fixed infra + prepaid AI | **£6/h** / **£3/h** | No |
| X5 | Backend/env compromise (Railway, GitHub → auto-deploy, dependency) | A, B | Master token → enable high-risk geo → outbound IRSF (1 CPS × 1 h × 60 min × $1.50/min) | Not geo-permissions (same token). Only prepaid balance w/o recharge (UNCONF whether API can change recharge), Twilio fraud desk (UNCONF) | **~£256k in the first hour** (ASM) | **YES** |
| X6 | Backend compromise | A, B | Buy 5,000 numbers | None found | **~£13.8k/month recurring** (list) | **YES** |
| X7 | Backend compromise | Any | OpenAI key used for other workloads ("LLM-jacking") | OpenAI prepaid with auto-recharge OFF | = prepaid balance | Yes, until prepaid configured |
| X8 | Backend compromise | Any | Supabase service role → exfiltrate customers, contacts, call logs | None cost-side; ICO/GDPR exposure | Regulatory: up to 4% turnover / £17.5m (statutory max) | **YES** (Gate 6) |
| X9 | Compromised admin (no MFA) | Current | Mass complimentary invites → scripted households → a number each | App-only | N × £0.87–£2.77/month; unbounded N | **YES** |
| X10 | Stolen cards | Current | Card testing / fraudulent subs → numbers + disputes | Stripe Radar/3DS (independent), number lifecycle | Per fraud sub: dispute fee (~£20, ASM) + number until release | No (bounded by Stripe), monitor |
| X11 | Compromised Twilio console login | Any Twilio | Everything, incl. auto-recharge | Card limit / Twilio fraud desk | Card limit | **YES** until hardware MFA + no stored high-limit card |
| X12 | Compromised customer account | Current | Mint Voice tokens (1 h TTL) with outgoing grant | TwiML App config (console): **must return nothing dial-able** (UNCONF) | £0 if the TwiML App is a no-op; unbounded if it dials | Verify |
| X13 | App bug / retry storm | Current | Provisioning retries (5 per household), SMS repeats | App-only | Bounded per household; global unbounded | Medium |
| X14 | SIP credential theft | B, C | Outbound fraud via carrier trunk | Carrier: **outbound barred at carrier**, IP-auth only (QUOTE) | £0 if barred | Yes, until confirmed |

**Answer to the fundamental question.** If HCG were compromised tonight, the maximum bill **cannot be bounded** by anything outside the attacker's control, except a Twilio or OpenAI prepaid balance whose configuration is unknown (UNCONF). Where configured, those balances take the whole service down when exhausted. **RELEASE BLOCKER (PROVEN).**

## 7. Hard spend controls (layered)

| Level | What can be limited | Where it lives | HCG-controlled? | Provider-enforced? | When reached | Bypassable by an attacker who owns HCG's backend? |
|---|---|---|---|---|---|---|
| Call | Duration (`<Dial timeLimit>`), monitoring 30 min | TwiML (app) | Yes | Twilio enforces the value **the app sends** | Call ends | **Yes** (they write the TwiML) |
| Call | Carrier max call duration | SIP carrier (QUOTE) | No | Yes | Call ends | No |
| Household | Concurrency, burst, £/day (unmerged branch) | App DB | Yes | No | Must become transport-only, not refusal | Yes |
| Household | **Per-DID concurrent channels** | SIP carrier (QUOTE) | No | Yes | Excess calls busy | No |
| Hourly/daily | Company £ velocity (unmerged) | App DB | Yes | No | Monitoring stops | Yes |
| Destination | International / premium / high-risk blocks | Twilio geo-perms | Console **and API** | Yes, but changeable with the auth token | Calls blocked | **Yes, with master token or standard key** |
| Destination | Outbound barred entirely | SIP carrier trunk config (QUOTE) | No | Yes | No outbound | No (portal + MFA) |
| Concurrency | Account concurrency | Twilio: none configurable (approved accounts unlimited) | — | — | — | — |
| Concurrency | Trunk channels | SIP carrier | No | Yes | Busy | No |
| AI/API | OpenAI spend | Prepaid credit, recharge off | Console | Yes | All AI stops (org-wide) | No, if console MFA holds |
| AI/API | Transcription only with a signed-call reservation | App (unmerged) | Yes | No | No AI | Yes |
| Carrier account | Twilio | Prepaid balance, recharge off | Console | Yes | **Everything suspended** | No, if console MFA holds and the API can't change recharge (UNCONF) |
| Carrier account | SIP carrier prepaid / credit limit | Carrier (QUOTE) | No | Yes | Service stops | No |
| Infra | Railway hard limit; Supabase spend cap | Provider | Console | Yes | Services offline / overage blocked | No, if console MFA holds |
| Global | Kill switches (unmerged) | App DB | Yes | No | Calls/monitoring stop | Yes |

**Credential isolation is required for any Twilio-based architecture (A or B) to pass Gate 2 (LIKELY feasible; needs Twilio confirmation):**
1. Webhooks authenticated with **HTTP Basic auth** in the webhook URL (PUBLISHED), so the backend stops needing the master auth token.
2. The **Voice token minter** (needs a *standard* API key, PUBLISHED) moves to a tiny isolated service with its own secrets, a strict rate limit and no other capability. Or ask Twilio whether a standard key can be scoped away from Dialing Permissions and number purchase.
3. The backend holds only **restricted keys** (PUBLISHED GA): no Dialing Permissions, no IncomingPhoneNumbers create, no Accounts/Keys.
4. Number provisioning becomes a separate, rate-limited provisioner with a **global ceiling on owned numbers**.
5. The master auth token lives only in a password manager. Console access: hardware-key MFA.
6. **Ask Twilio:**
   - Can Dialing Permissions and SMS geo-permissions be locked so that only the console (MFA) can change them?
   - Can outbound voice be disabled at account level?
   - Can auto-recharge be changed via the API?

**The best independent containment available (LIKELY):**
- **Option B or C with a SIP carrier that:** is inbound-only (outbound barred), uses IP-authentication, has per-DID and account channel caps, and is prepaid.
- **Twilio (for B):** a **dedicated** account holding no numbers, geo-permissions all off, prepaid with auto-recharge off, sized to N days of capped traffic.
- **OpenAI:** prepaid with auto-recharge off.
- **Railway and Supabase:** hard caps.

With those settings the worst case is the sum of the balances and caps, and it is known in advance.

## 8. Safe limit and failure behaviour

**Architectural deficiency statement (PROVEN):**
- Under unconditional forwarding (Options A, B and C), every call to the customer depends on HCG accepting it.
- There is **no state** in which HCG stops incurring per-call cost **and** the customer keeps receiving calls.
- Refusing calls breaks the customer's telephone service. Continuing to carry calls continues the cost.
- The forwarding model **cannot satisfy requirements #1 and #4 simultaneously on its own.**

What *can* be made safe:

| Mechanism | Financially bounded? | Customer calls preserved? | Status |
|---|---|---|---|
| A: Twilio prepaid balance exhausted | Yes | **No** (all customers down) | PROVEN |
| B/C: carrier channel caps (per-DID + account) | Yes (fixed capacity) | Mostly: only calls beyond the cap fail; a flood on one DID doesn't affect others **if per-DID caps exist** | UNCONF (per-DID) |
| B/C: marginal cost ~£0/min (C) or bounded Twilio minutes behind channel caps (B) | Yes: carrying calls costs fixed capacity or bounded minutes, not unbounded per-minute | Yes, within capacity | LIKELY |
| Customer exit: verified forwarding removal before HCG stops (previous paper §3) | Yes (after exit) | Yes | Needs customer action; slow |
| D: network default = normal delivery | **Yes: HCG cost stops** | **Yes** | UNCONF (provider) |
| Carrier failover to carrier voicemail when HCG is down | Carrier-dependent | Voicemail only | QUOTE |

**Recommendations:**
- Do **not** deploy the unmerged household £-ceiling call refusals.
- Do **not** rely on "transport-only mode" alone: on A it still pays per minute without limit.
- The financially safe state for a forwarding architecture is **capacity-bounded carriage (B or C behind provider channel caps, plus prepaid provider balances)**, and ultimately D.

## 9. Security and denial-of-wallet threat model (HCG-specific)

| Threat | Impact | Likelihood | Current control | Gap | Required control | £ max if exploited | Release blocker |
|---|---|---|---|---|---|---|---|
| Forged `/media-stream` → SMS/AI (§0) | £, brand, harassment, Twilio suspension | **High** (public endpoint, simple script) | 200-stream cap; shadow signature check | No auth; SMS destination from attacker | Enforce signature; server-side destination; SMS geo UK-only | ~£1.5k/h+ (ASM) | **YES** |
| Inbound call flood (A) | £ | Medium | None enforced on main | No provider cap | B/C channel caps | £469/h per 500 channels, unbounded | **YES** |
| Unsigned `/voice` (forged POSTs) | Pollutes calls table, activation data; with the unmerged branch, could exhaust limits | Medium | Signature gates only the activation stamp | No auth on call handling | Basic-auth webhook URL or enforced signature | Low direct £ | YES (for any counter-based control) |
| Master auth token in backend env | Full Twilio account takeover | Low–medium (Railway/GitHub/dependency compromise) | Env vars | Over-privileged credential | §7 isolation | ~£256k/h (X5) | **YES** |
| GitHub compromise → auto-deploy | Code execution in prod | Low–medium | Account security only (no CI workflows found) | No protected-branch/deploy approval evidence | Branch protection, required review, deploy approval, 2FA | = backend compromise | **YES** |
| Railway account compromise | Secrets + deploy | Low–medium | Unknown MFA | — | Hardware MFA, least-privilege team | = backend compromise | **YES** |
| Supabase service-role leak | Full data breach | Low–medium | Env; RLS for anon/auth | Service role bypasses RLS | Minimise its use; rotate; audit | Regulatory | **YES** (Gate 6) |
| Admin compromise (no MFA) | Data breach; invites → numbers; entitlement changes | Medium (password-only) | `user_roles` check | No MFA; no invite ceiling | Supabase MFA (aal2) for admin; invite and number ceilings | Unbounded numbers (X9) | **YES** |
| Password reset / account takeover | Customer's contacts, calls, forwarding info | Medium | Supabase auth; token-hash flows | No rate limiting found | Rate limits; notification of changes | Low £ | No (but fix) |
| Bot registration (`/api/v1/register`) | Email cost, auth quota, spam | Medium | None | No rate limit / CAPTCHA | Rate limit + CAPTCHA | Low £ | No |
| Stolen cards / free-trial abuse | Disputes, numbers | Medium | Stripe (3DS/Radar) | No number ceiling | Radar rules; number only after payment clears; global number cap | Bounded per fraud | No |
| Voice token outgoing grant | Outbound calls if the TwiML App dials | Low | Comment says the TwiML App returns "not supported" | **Unverified console config** | Verify; remove the outgoing grant if the SDK allows | Unbounded if misconfigured | Verify (YES until verified) |
| Forged Twilio status callbacks | Corrupt delivery/duration data | Medium | None | No auth | Basic-auth URLs | Low £ (inflates ledger) | No |
| Replay of RevenueCat/Stripe webhooks | Duplicate entitlements | Low | Stripe signature + idempotency; RevenueCat shared header (no signature/timestamp) | RevenueCat replay possible if the header leaks | Idempotency on event id (check); rotate header | Numbers | No |
| RevenueCat sandbox purchases | Real numbers for sandbox | Known (memory) | Unmerged fix branch | — | Environment guard | Small | No |
| Push credential theft (APNs/FCM) | Spoofed pushes / call UI spam | Low | Stored in Twilio/Firebase | — | Rotate; least privilege | Low £ | No |
| SIP credential theft (B/C) | Toll fraud | Medium (SIP is scanned constantly) | n/a today | — | IP-auth only; outbound barred | £0 if barred | YES for B/C until confirmed |
| Retry storms / bugs (provisioning, SMS) | £ | Low–medium | Per-household retry cap (5) | No global cap | Global number/SMS ceilings (provider where possible) | Bounded | No |
| Trusted-contact spoofing | Scam call bypasses protection | Medium (CLI spoofing) | None | Trusted = caller ID match | Network CLI validation (D spec R6); UK CLI blocking helps | Customer harm | No (product risk) |

## 10. Additional safe providers to contact (quality over quantity)

| Provider | Role | Competitive risk | Why | Route |
|---|---|---|---|---|
| **Sipflex (Cloud2Tel)** | Free-inbound DDIs, channels, API, **"spend and destination controls"** | **LOW** (no scam product found) | Best-fit carrier leg for B/C | support@sipflex.co.uk · 0800 810 1057 (high-volume enquiries invited) |
| **sipgate trunking** | Free-inbound trunking | **LOW** (not fully checked for app-level spam features) | Second carrier for redundancy | sipgatetrunking.co.uk |
| **Magrathea** | UK range holder / wholesale numbers | **LOW–MEDIUM** (carrier-level anti-scam initiatives; no consumer product listed) | Wholesale number price is the biggest B/C cost lever | 0345 004 0040 · info@magrathea-telecom.co.uk · magrathea-telecom.co.uk/contact |
| **Gamma (wholesale / Three MVNO partner)** | SIP + possible MVNO route | **LOW** (AI virtual agent for business only) | Scale carrier; possible D-via-MVNO | Not verified tonight |
| Plivo | Alternative CPaaS | LOW | Fallback to Twilio | plivo.com/contact/sales |
| **Do not disclose detail to:** Hiya (**HIGH**: powers Vodafone), Telnyx (**MEDIUM**: live-audio deepfake detection), VMO2 (**HIGH**: Call Defence; send only the routing spec). Simwood/Transatel excluded per instruction. | | | | |

## 11. Launch gates

| Gate | Status | Evidence needed for PASS |
|---|---|---|
| 1 Unit economics | **UNPROVEN** | Pilot-measured forwarded-minute distribution (≥ 100 real households × 1 month) with cost ≤ the tolerable figure at the chosen price; written quotes (carrier volume, Twilio BYOC/SDK, wholesale numbers); Apple SBP status |
| 2 Financial containment | **FAIL** | Written provider confirmation of every control in §7 (carrier outbound bar, per-DID caps, prepaid; Twilio geo-lock, recharge API behaviour, dedicated account); credential isolation implemented; a signed worst-case figure = sum of prepaid/capacity bounds that Andrew accepts |
| 3 Cybersecurity | **FAIL** | §0 fixed; `/voice` authenticated; master token removed from backend; admin MFA; rate limits; GitHub/Railway MFA + branch protection; TwiML App verified; external security review / pen-test of the auth and webhook surfaces |
| 4 Call reliability | **UNPROVEN** | ≥ 99% approved-call ring success (DECISION on the bar) on iPhone **and** Android over ≥ 2 weeks of real traffic, including killed-app/Doze; FCM NotRegistered recovery proven (28 Sep incident) |
| 5 Safe failure | **FAIL** (A/B/C, structural) | Either D confirmed, or an accepted, documented degraded mode (capacity-bounded carriage + carrier voicemail on HCG outage) explicitly approved by Andrew as meeting #1 |
| 6 Supabase/data security | **UNPROVEN** | Production RLS/grant verification run and attached; service-role usage inventory; admin MFA; data-retention and deletion evidence; prior RLS incident closed |
| 7 Provider architecture | **UNPROVEN** | Signed quotes and technical confirmation for the selected architecture (B carrier + Twilio BYOC terms, or D capability + fee) |
| 8 Insurance | **UNPROVEN** (not required before material scale) | Broker-confirmed cover map against §12's checklist, with telecom-fraud and cost-overrun exclusions understood |

**Overall: NO GO.** Release-blocking gates 2, 3 and 5 FAIL.

## 12. Insurance requirements checklist (for a UK cyber/tech broker; nothing arranged)

**Covers to ask for:**
1. Cyber liability: data breach response (forensics, legal, notification, credit monitoring), privacy liability, **regulatory defence and fines where insurable** (ICO).
2. Technology professional indemnity / errors and omissions: a customer harmed because protection failed or a call was missed.
3. Business interruption, including **dependent/contingent BI** (Twilio, carrier, Railway, Supabase, Apple/Google push outages).
4. **Telephone hacking / toll fraud** extension. Typically **optional and sublimited** (commonly ≤ ~£/$250k or much lower). Confirm it covers **cloud CPaaS/SIP accounts**, not only on-premises PBXs.
5. Cyber crime: social engineering, funds-transfer fraud.
6. Incident response retainer (24/7).
7. Media liability (HCG-branded warning SMS/calls).

**Likely exclusions to check explicitly (do NOT assume cover):**
- **Runaway usage bills from HCG's own bugs, misconfiguration or retry storms**: not a "cyber event"; usually excluded or not triggered.
- **Denial-of-wallet / unauthorised use of computing resources** (LLM-jacking, cloud/API abuse): often excluded or sublimited; wording varies.
- **Toll fraud without the extension**, or where security conditions weren't met (MFA, patching, default passwords): **failure-to-maintain-security** conditions.
- **Contractual liability** (amounts owed to Twilio or a carrier under contract) and **voluntary payments**.
- Losses caused by a **third-party provider's own failure**, unless contingent BI is bought.
- Prior known incidents / retroactive date; war and state-actor exclusions; fines that are uninsurable by law.
- Bodily injury / financial loss of *customers* from scams HCG failed to stop (PI wording).
- PCI fines (usually sublimited).

**Underwriting will expect:** MFA everywhere, backups, EDR/patching, incident plan, vendor risk management, and toll-fraud controls (geo-blocks, spend caps). §7 is also what makes HCG insurable.

**Insurance is not a substitute for §7 containment.**

## 13. Questions providers must answer

**Twilio:**
- Why are HCG's billed rates below list (inbound £0.00756 vs $0.0100; number £0.87 vs $3.50; SDK £0 vs $0.004)? Are they contractually stable?
- For BYOC-originated calls, is billing BYOC only, or BYOC plus SIP interface? Is the SDK leg still £0? What billing increment?
- Can Dialing Permissions / SMS geo be locked against API changes? Can outbound voice be disabled at account level? Can auto-recharge be changed via the API?
- Can a standard API key be scoped away from number purchase and dialing permissions, or can Access Tokens be minted with anything narrower?
- Is inbound concurrency configurable per account or per number? Is there a spend-limit product?
- What fraud monitoring/suspension applies to IRSF on HCG's account?

**SIP carrier (Sipflex, sipgate, Magrathea, aql):**
- Free inbound at 1k–10k DDIs and ~0.3–3M min/month, in writing? Fair-use terms?
- **Per-DID concurrent-channel caps?** Account channel caps? **Outbound barred at trunk level?** IP-auth only?
- Prepaid/credit limits; max call duration; failover destinations (voicemail); SLA; number porting-out terms; BYOC-to-Twilio interop experience.
- Wholesale DDI price at volume.

**MNO/MVNE (BT/EE, Vodafone, VMO2, Wireless Logic/Cloud9, aql):** the full `CARRIER_TECHNICAL_SPEC.md`, especially:
- default handling fail-open;
- loop-safe return;
- CLI validation;
- per-subscriber fee;
- Call Forwarding Signal API availability.

**OpenAI:** a per-project hard cap exists? Confirm prepaid + recharge-off behaviour and cut-off latency.

**Railway / Supabase:** confirm hard-limit and spend-cap behaviour on HCG's plans.

## 14. Exact unresolved blockers

1. **§0 forged media streams** (probably live): fix, and decide on a hotfix.
2. **Master Twilio auth token in the backend**; no independent limit on outbound/number-purchase fraud.
3. **No provider-enforced bound on inbound flood cost** under the current architecture.
4. **Twilio and OpenAI auto-recharge / prepaid configuration unknown**. The only existing hard stops depend on it.
5. **Structural safe-failure deficiency** of unconditional forwarding (§8). Needs Option D, or Andrew's explicit acceptance of capacity-bounded carriage plus a voicemail fallback.
6. **Admin without MFA**; no global ceilings on invites or owned numbers.
7. **TwiML App outgoing configuration unverified** (Voice token outgoing grant).
8. **GitHub/Railway/Supabase/Twilio console MFA and branch protection unverified.**
9. **Unmerged financial-safety branch refuses calls** at household £ ceilings. Must not ship as-is; its reservation-gated transcription is the part to keep.
10. **No measured usage distribution** (Gate 1).
11. **Every B/C/D provider capability and price is unconfirmed** (Gate 7).
12. **Call reliability unproven** on both platforms (Gate 4).
