# HCG architecture reassessment from first principles (2026-10-10)

**Status:** research and planning only. No code, tests, purchases or production changes.

**Trigger:** Lebara confirmed that external call forwarding is unsupported across its whole UK network, including by support. The requirement is that HCG works for customers on **all major UK networks and MVNOs**, with **no change of provider, no hardware, no complicated set-up**, at **£5.99**, with sustainable margin and **hard cost limits**.

## 1. The constraint that decides everything

HCG's **live AI screening** works by hearing an unknown caller's conversation. A third-party app can get a call's audio in only two ways:

1. **The call passes through HCG's telephony.** Today that means the customer **forwarding** calls to an HCG number. Some networks don't allow it: Lebara (all external forwarding); Vodafone PAYG and Tesco per HCG's own carrier data; Virgin Mobile has stated it doesn't support forwarding. So **no forwarding-based design can work on all networks.** This includes **today's product**, which depends on unconditional forwarding (`**21*`).
2. **The phone gives the app the call audio.** Verified in AOSP source (`frameworks/base/telecomm/java/android/telecom/`):
   - `Call.enterBackgroundAudioProcessing()` is **`@SystemApi`** and can only be called by the default dialer.
   - `CallScreeningService.CallResponse.Builder.setShouldScreenCallViaAudioProcessing()` is **`@SystemApi`**, requires **`CAPTURE_AUDIO_OUTPUT`**, and "will only be honored if the CallScreeningService shares the same uid as the system dialer app".
   - So only preinstalled system apps (for example Google's Call Screen) can hear a call. **HCG cannot, even as the default phone app.**
   - iPhone exposes **no** cellular-call audio, routing or rejection API to apps.

**Also verified:**
- `CallRedirectionService` handles **outgoing** calls only.
- `CallScreeningService` can allow, disallow, reject, **silence**, and skip the log or notification, but it **cannot redirect** an incoming PSTN call.

**Conclusion:** *live AI screening of unknown callers on all UK networks, without carrier cooperation or forwarding, is not technically possible for a third-party app on Android or iPhone.* The requirements conflict. One of them has to give: "all networks", or "live AI screening for everyone".

### Urgent consequence for today's product

`services/providerPolicy.js:181` marks **Lebara as `compatible`**, in production `eb43368` and in the release candidate. After Lebara's statement:
- **a Lebara customer can pay but cannot forward calls, so they get no protection;**
- Lebara must become `incompatible` before any further sales;
- Tesco is already `incompatible`; Lyca, VOXI, ASDA and "other" are `unverified`.

This document doesn't change the code (research only).

## 2. Options considered and rejected

| Idea | Why rejected |
|---|---|
| Android screening app redirects unknown calls to HCG | Impossible: no incoming redirect API (above) |
| HCG as the default dialer, processing call audio on the device | `@SystemApi` + `CAPTURE_AUDIO_OUTPUT`, system apps only (above) |
| Silence + no-answer forwarding (Test A) | **Mechanism proven on Lebara/Android 10**, but it needs conditional forwarding to an external number. Unsupported on Lebara and other MVNOs. Android only |
| iPhone silence + conditional forwarding | Same forwarding dependency; T4 untested; Apple controls the trust list |
| Porting the customer's number to HCG, or an HCG MVNO/FMC SIM | Changes provider or SIM. Fails the requirement |
| A second HCG number for the public | Scammers call the real mobile number. No protection |
| Carrier APIs (CAMARA, Open Gateway UK) | Read-only (identity, forwarding status). No consumer API for selective diversion |
| Partnership with an MNO (network-side screening) | Plausible long-term (MNOs already sell pre-answer scam products) but needs carrier cooperation and a long sales cycle. Not a launch path |

## 3. The three most credible options

### Option 1: On-device protection ("HCG Shield"). Universal, near-zero call cost

- **What it is:** calls ring on the customer's own phone with **no forwarding**.
  - **Android:** the HCG app holds the call-screening role (approved for caller-ID/spam apps). Trusted contacts, from HCG's synced trusted list, ring normally. Unknown callers are, by the customer's choice, **silenced to the carrier's own voicemail** (proven in Test A) or **ring with a clear "not a trusted contact" warning**. The app adds number intelligence (Ofcom number ranges, HCG's crowd reports, known scam numbers, invalid/spoofed-format checks), a post-call "did they ask for money or codes?" prompt, and a **family alert** (push to a relative) when an unknown caller gets through.
  - **iPhone:** Call Directory labels and blocks known scam numbers, plus guided use of Apple's *Silence Unknown Callers* setting. **Weaker than Android:** iOS keeps the trust list itself and no per-household app logic is possible.
- **Technically possible vs speculative:** Android silence/allow is **proven** (Test A, and the whole caller-ID app category). Scam-number intelligence quality is **to be built and measured**. **No live conversation analysis is possible.**
- **Platforms:** Android full; iPhone limited.
- **Carrier cooperation / forwarding:** **none.** Works on **every network** (Lebara included).
- **Trusted calls avoid chargeable legs:** **yes, completely.** Unknown calls also cost HCG nothing for telephony.
- **Set-up:** install, then one system prompt ("set as caller ID & spam app"), then import trusted contacts. **No codes.**
- **Cost and scalability:**
  - No HCG phone number is needed per customer (saves £0.87 a month).
  - Variable cost is about **£0.05–£0.20 per customer per month** (infrastructure, number lookups).
  - Margin at £5.99: web/Stripe about **85–88%**; Play/App Store at 15% about **78–81%**. Scales linearly.
  - **There is no per-minute exposure at all, so a hard cost limit is trivial.**
- **Main risk: value.** The product loses its distinctive live AI conversation screening, and competes with free caller-ID apps and carriers' free scam blocking. **Willingness to pay £5.99 is unproven.**

### Option 2: Forwarding-based live screening on a usage-independent backend. Where networks allow it

- **What it is:** keep today's product (the customer forwards calls to an HCG number; trusted calls ring the HCG app; unknown calls are AI-monitored), but **move inbound off Twilio's per-minute billing**:
  - geographic numbers on a **free-inbound UK carrier** (Magrathea: live calls 1–4 passed 2026-10-08/09; or AQL or Gamma);
  - a **self-hosted SIP/media server** delivering calls to the app over VoIP push;
  - AI cost only on unknown calls, within the capped allowance.
- **Technically possible vs speculative:** inbound to Magrathea is **proven**. Self-hosted delivery to the app (replacing the Twilio Voice SDK leg), high availability and push handling are **not built**: weeks of work plus an operations burden. Magrathea quoted a **£100/month minimum**.
- **Platforms:** Android and iPhone (as today).
- **Carrier cooperation / forwarding:** **needs unconditional forwarding.** Works on most pay-monthly plans of the big four, Sky, iD and giffgaff (per HCG's carrier data); **fails** on Lebara, Tesco, Vodafone PAYG and some MVNOs. **Does not meet "all networks".**
- **Trusted calls avoid chargeable legs:** they **still pass through HCG**, but at about **£0 per minute** (free inbound plus self-hosted delivery). Cost becomes fixed per customer, not per minute. **This does not avoid HCG infrastructure.**
- **Set-up:** one forwarding code (as today), and the number must be on a supported network.
- **Cost and scalability (estimates):**
  - Fixed costs about **£150–£400/month** (carrier minimum + servers).
  - Per customer about **£0.10–£0.90** (number) + **about £0.2–0.5** (AI on unknown calls, within the cap).
  - At £5.99, margin below 40% until roughly **150–300 customers**, then about **60–75%** at scale.
  - Hard limits are easy, because only AI minutes are variable.

### Option 3 (recommended): Hybrid. Universal on-device base, plus optional live screening where forwarding works

- **What it is:**
  - **£5.99 base for everyone:** Option 1, on all networks, Android and iPhone.
  - **"Live Call Guard":** an add-on or higher tier for customers whose network supports forwarding. It uses Option 2's backend. On Android, where the network supports conditional forwarding, it uses **silence + no-answer forwarding**, so **only unknown calls reach HCG** (proven mechanism; carrier-dependent). Otherwise unconditional forwarding. The app detects the network and offers live screening **only where it can work**.
- **Possible vs speculative:** base = proven mechanisms; live tier = today's product (proven), with Option 2's cost work still to build.
- **Platforms:** both. The live tier is strongest on Android.
- **Carrier / forwarding:** the base needs none. The live tier needs it, and is offered **only** where supported.
- **Trusted calls avoid chargeable legs:** in the base, **yes**. In the live tier, about £0 per minute (Option 2) or, with conditional forwarding, never reach HCG.
- **Set-up:** base = one prompt. Live tier = one forwarding code, offered only on supported networks.
- **Cost and scalability:** the base carries the business on every network at about 80–88% margin. The live tier is priced to its own cost (for example £7.99–£9.99, to be validated). Hard limits come from the design (base) and the Fortress allowance (live).

## 4. Recommendation

- **The current single-product design cannot meet "all networks, no carrier change, no complicated set-up".** That's a fact of the platforms and networks, not something more engineering can fix.
- **Recommended:** Option 3. Launch the **on-device base** as the universal £5.99 product, and keep live AI screening as an **optional tier on networks that support forwarding**. Move that tier to a usage-independent backend (Option 2) before it scales.
- **Before building:**
  1. **Test willingness to pay** for the on-device base: landing-page or cohort test, because this is the biggest commercial risk.
  2. **Decide positioning.** Today's message ("AI listens to scam calls") becomes a tier feature.
  3. Pause the soft-launch deploy (live screening for everyone) until positioning is decided, **except the production containment hotfix**, which is needed regardless.
- **If on-device protection alone isn't worth £5.99 to customers, and "all networks" is non-negotiable, then no option meets every requirement.** The remaining route is an **MNO partnership** (network-side screening), which is a business-development track, not an engineering one.

## Sources

- AOSP `frameworks/base/telecomm/java/android/telecom/Call.java`: `enterBackgroundAudioProcessing` (`@SystemApi`, default dialer).
- AOSP `CallScreeningService.java`: `setShouldScreenCallViaAudioProcessing` (`@SystemApi`, `CAPTURE_AUDIO_OUTPUT`, system-dialer uid only); `setSilenceCall`.
- AOSP `CallRedirectionService.java`: outgoing calls only.
- HCG evidence:
  - Test A, `docs/routing/ws5/TEST-A-RESULTS-2026-10-10.md`;
  - Magrathea live calls, `research/magrathea-trial-poc`;
  - carrier compatibility, `services/providerPolicy.js`;
  - unit economics, `docs/launch/2026-10-10-COMMERCIAL-ALLOWANCE-PROPOSAL.md`.
- Lebara's written statement to Andrew (2026-10-10): external forwarding unsupported network-wide.
