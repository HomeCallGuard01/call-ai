# HCG subscription price: evidence for tomorrow's decision

Research only, 2026-10-01. No live price or production setting was changed. Model: `subscription-design.js`; full tables in `SUBSCRIPTION_DESIGN_OUTPUT.md`.

## Requirements tested separately (never traded off)

| # | Requirement | Test |
|---|---|---|
| R1 | Economics | ≥ 40% contribution margin under **normal** usage |
| R2 | Solvency | ≥ 0% under **high legitimate** usage: both the heavy and stress mixes |
| R3 | Containment | A **hard, externally enforced** maximum loss per incident and per household. Averages never count as containment. |

**Architecture assumed:** Option B. A free-inbound UK SIP carrier feeds Twilio BYOC, and calls reach the app through the existing Voice SDK. It's the only architecture that is both buildable now and externally boundable:
- Option A (Twilio today) can't be bounded;
- Option C needs ≥ ~10k subscribers;
- Option D is unconfirmed.

**What "contribution" includes:**
- all payment costs: VAT, Apple/Google 15%, Stripe, refunds 2%, disputes;
- telecom: numbers (+5% held in quarantine), SIP channels, BYOC, SDK leg, greeting, SMS, Media Streams;
- transcription;
- platform: Railway, Supabase, email, monitoring, Apple Developer, isolated token service, insurance;
- support and onboarding;
- fraud contingency.

It excludes founder salary and marketing/customer acquisition.

## 1. Result at the conservative, fully loaded base (1,000 subscribers)

Inputs: SDK leg charged at list, £2 retail numbers, Apple 15%.

| Price | Contribution £/sub (normal) | Normal | Heavy | Stress | Break-even avg min | 40% reached only if avg min ≤ |
|---|---|---|---|---|---|---|
| £5.99 | −£0.84 | −17% | −36% | −59% | 145 | never |
| £6.99 | −£0.13 | −2% | −19% | −39% | 226 | never |
| £7.99 | £0.58 | 9% | −6% | −23% | 306 | 5 |
| £9.99 | £2.01 | 24% | 12% | −1% | 467 | 91 |

**No price from £5.99 to £9.99 meets R1 on conservative inputs.** Fixed per-subscriber costs are £2.86/month before a single minute:

| Fixed cost | £/sub/month |
|---|---|
| Numbers | £2.10 |
| Support | £0.42 |
| Platform | £0.24 |
| Fraud contingency | £0.10 |

## 2. What decides the price: two unverified inputs

Each cell shows the normal / heavy / stress margin. ✔ means R1 and R2 both pass.

| Scenario | £5.99 | £6.99 | £7.99 | £9.99 |
|---|---|---|---|---|
| SDK at list, numbers £2.00 | −17 / −36 / −59 | −2 / −19 / −39 | 9 / −6 / −23 | 24 / 12 / −1 |
| SDK £0, numbers £2.00 | 1 / −11 / −25 | 13 / 3 / −9 | 22 / 13 / 3 | 35 / 28 / 19 |
| SDK at list, numbers £1.00 | 4 / −15 / −38 | 16 / −1 / −21 | 25 / 10 / −7 | 37 / 25 / 11 |
| **SDK £0, numbers £1.00** | 22 / 10 / −4 | 31 / 21 / 9 | **38** / 29 / 19 | **47 / 40 / 32 ✔** |
| SDK £0, numbers £0.50 | 32 / 21 / 7 | **40 / 30 / 18 ✔** | 46 / 37 / 26 ✔ | 54 / 47 / 38 ✔ |
| Same as above, Apple 30% | 26 / 14 / 0 | 33 / 23 / 11 | 39 / 30 / 20 | 47 / 40 / 31 ✔ |

The two inputs:
1. **Does Twilio charge the Voice SDK leg on BYOC-originated calls?** £0 is invoiced on today's calls (CONFIRMED), but the published list is $0.004/min (QUOTE for BYOC). That's worth **~13–20 margin points**.
2. **The wholesale price of UK geographic numbers** at 1k–10k volume. Sipflex's published retail is £2.00; Magrathea's 2021 documents said £0.50 (stale). That's worth **~15–30 points**.

Other material inputs:
- Apple Small Business Program enrolment: 15% vs 30%, ~7 points.
- Whether Twilio also charges the SIP interface on BYOC calls: ~−15 points at list.
- The real usage distribution, which has never been measured.

## 3. Per price under the best-evidenced plausible case

Case: SDK £0, numbers £1.00 wholesale (QUOTE), Apple 15%.

| Price | Contribution £/sub | Normal | High (heavy / stress) | Break-even avg min | Falls below 40% when avg forwarded min > |
|---|---|---|---|---|---|
| £5.99 | £1.10 | 22% | 10% / −4% | 453 | never reaches 40% (≤ 66 min needed) |
| £6.99 | £1.81 | 31% | 21% / 9% | 590 | never reaches 40% (≤ 139 min needed) |
| £7.99 | £2.52 | 38% | 29% / 19% | 729 | below 40% already: needs ≤ **212** min (normal is 240) |
| £9.99 | £3.94 | **47%** | 40% / 32% | 1,005 | **359 min** |

The normal mix averages **240 forwarded min/sub/month** (ASSUMPTION; Ofcom: 146 *outgoing* min/month average).

**Where each price crosses 40%, moving one driver at a time** (same case; full list in the output file):

| Price | Crosses 40% when |
|---|---|
| £9.99 | average usage > 359 min, **or** numbers > **£1.58**, **or** SDK and SIP both billed at list (26% at £1 numbers), **or** Apple 30% and numbers > **£1.05** |
| £7.99 | Needs usage ≤ 212 min, or numbers ≤ **£0.86**, to reach 40% |
| £6.99 | Needs numbers ≈ £0.50 **and** SDK £0 **and** Apple 15% |

## 4. Individual households (no averaging)

Monthly contribution per single household, best-evidenced case:

| Household | Minutes/month | £5.99 | £6.99 | £7.99 | £9.99 |
|---|---|---|---|---|---|
| Normal | 175 | +£1.46 | +£2.18 | +£2.89 | +£4.31 |
| High | 510 | −£0.11 | +£0.61 | +£1.32 | +£2.74 |
| Targeted by scammers | 270 | £0.00 | +£0.71 | +£1.42 | +£2.85 |
| **Extreme legitimate** | 1,500 | **−£5.87** | **−£5.16** | **−£4.45** | **−£3.02** |

At conservative inputs the extreme household loses £9.51–£12.35 a month at every price. **Every price leaves extreme legitimate households loss-making.** A higher price alone doesn't fix that.

**The hard, external per-household bound is the carrier's per-number concurrent-channel cap** (QUOTE), not any price:
- 1 channel: **£273/month**;
- 2 channels: **£546/month**.

Tighter limits (e.g. £10/day) exist only in HCG's own code, so they are not external. The commercial handling of extreme legitimate users (personal/household-use terms; commercial-use review and a business plan offer; never a minute cut-off) is policy, not containment.

## 5. Hard, externally enforced maximum loss per incident (Option B)

| Component | 1,000 subs | 5,000 subs |
|---|---|---|
| Twilio dedicated delivery account: prepaid, 14 days, **auto-recharge off** | £917 | £4,584 |
| In-flight overrun after suspension: channels × 240 min | £123 | £454 |
| OpenAI prepaid, 14 days, auto-recharge off | £87 | £436 |
| SIP carrier credit: inbound-only, outbound barred, channel caps | £554 | £2,732 |
| Railway hard limit / Supabase spend cap | £190 | £350 |
| **Maximum loss per incident** | **≈ £1,870 (38% of a month's net revenue at £6.99)** | **≈ £8,560 (35%)** |

**This bound holds only if Twilio confirms** that outbound voice and international SMS can be disabled on the delivery account **and locked against API change**. Otherwise a compromised credential can place international calls, and calls already in flight run on after the balance is exhausted: **unbounded**.

Exhausting any float stops service for **all** customers until a human tops it up. That's the forwarding deficiency (see `CATASTROPHIC_RISK_REVIEW.md` §8).

## 6. Unverified assumptions (all prices)

| Item | Status |
|---|---|
| Twilio SDK leg on BYOC calls; BYOC-only vs BYOC + SIP interface; billing increment | QUOTE |
| Twilio's ability to lock outbound voice / SMS geo against API change; auto-recharge not API-changeable | QUOTE (release-blocking for R3) |
| Wholesale number price; free inbound at volume; **per-DID channel caps**; outbound bar; prepaid/credit limit | QUOTE |
| Apple SBP enrolment | UNCONFIRMED |
| Usage distribution (240 avg min, segment mix) | ASSUMPTION; no measured data (0 genuine paying customers) |
| Support £0.42/sub, refunds 2%, disputes 0.3% × £20, insurance £100/month, platform costs | ASSUMPTION |
| FX 0.79; transcription price stable | ASSUMPTION / PUBLISHED |
| BYOC interop with the chosen carrier; call reliability on iPhone and Android | UNPROVEN |

## 7. What the evidence supports deciding tomorrow

1. **Do not choose £5.99 or £6.99 on current evidence.** £5.99 fails R1 in every scenario tested. £6.99 passes only if numbers cost about £0.50 wholesale *and* Twilio keeps the SDK leg at £0 *and* Apple SBP is confirmed.
2. **£9.99 is the lowest price that meets R1 and R2 under a plausible, not best-case, verified cost base:** SDK £0 plus £1 wholesale numbers, or SDK list plus £0.50 numbers. It still **fails R1 if Twilio bills the SDK leg at list and numbers stay at £2 retail** (24%).
3. **£7.99 is the lowest defensible price only if two quotes land:** Twilio confirms the SDK leg stays £0 on BYOC, **and** wholesale numbers come in at ≤ **£0.86**/month. Then it's 40% normal and 21% stress (at £0.85). Otherwise it sits at 22–38%.
4. **No price satisfies R3 by itself.** Launch at any price requires the Twilio lock confirmation, carrier per-DID caps and outbound bar, prepaid floats with auto-recharge off, and the security blockers in `CATASTROPHIC_RISK_REVIEW.md`. **R3 is currently FAIL.**

**Recommendation:**
- Set the price **provisionally at £9.99**, with £7.99 as the target once the two quotes are in hand.
- Hold launch until R3 passes.
- Collect in the first month: Twilio's written BYOC billing (SDK and SIP interface), a wholesale number quote, Apple SBP status, and a measured forwarded-minute distribution from a capped pilot. Then re-run `subscription-design.js`.
