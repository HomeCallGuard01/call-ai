# Provider questions: drafts for Andrew to send (2026-10-10)

**Status:** these are DRAFTS. Nothing has been sent. No provider was contacted, and no account, console or API was used. Andrew reviews, edits and sends each one himself.

**Hygiene:** the drafts contain no secrets, no customer data, no personal phone numbers and no account SIDs. The only identifiers are Magrathea's own ticket and CDR references and the trial DDI, all of which Magrathea already holds.

**Sources:**
- Agent 1 §5 (draft questions) and Agent 6 §2 rows 7–8 and §5 (billing unknowns), in this folder.
- `MAGRATHEA-TWILIO-BYOC-INVESTIGATION.md` in this folder. It covers the Twilio documentation findings, including one confirmed finding: custom SIP headers on BYOC INVITEs are discarded.
- `/Users/ad/call-ai-magrathea-trial/docs/carriers/MAGRATHEA-QUESTIONS-FOR-BEN-DRAFT.md`: an earlier, unsent draft. The Magrathea draft below **replaces** it. Its still-relevant items are folded in here.

---

## 1. Twilio (support ticket or sales/account team)

**Subject:** Pricing and controls: inbound BYOC trunk calls delivered to the Voice SDK (UK)

> Hello,
>
> We run a UK consumer call-screening service on Programmable Voice. Inbound calls reach our UK numbers and are delivered with TwiML `<Dial><Client>` to our iOS/Android app (Voice SDK). Some calls also use `<Start><Stream>`. We are considering receiving calls from a UK carrier over a **BYOC trunk** instead of Twilio-hosted numbers. Before testing we need written answers to the questions below. Where an answer differs between Twilio-hosted numbers and BYOC, please give both.
>
> **A. Which legs are billed**
>
> *Why we ask: your GB pricing page lists BYOC "receive" $0.0040, SIP interface $0.0040 and browser/app $0.0040 per minute as separate lines. Whether they stack decides whether BYOC costs less or more than today's $0.0100 per minute.*
>
> 1. For one inbound call arriving on a BYOC trunk whose TwiML is `<Dial><Client>`, please list every billed line item: the BYOC termination leg, any "SIP interface" charge, and the Voice SDK/Client leg. Is the result $0.004, $0.008 or $0.012 per minute, or something else?
> 2. On our current invoices, the `<Dial><Client>` child leg of calls to Twilio-hosted numbers appears at £0. Is that correct and expected to continue? Would it also be £0 on BYOC calls?
> 3. Is each leg billed per started minute or per second? Is the parent leg billed while the `<Client>` leg is still ringing, before anyone answers?
> 4. If our TwiML returns `<Reject>`, either at once or after one webhook round trip, is the call billed at all (BYOC and hosted numbers)? Does anything else bill, such as a webhook fee or a minimum charge?
> 5. If a call is answered by `<Dial>` and the caller hangs up while the `<Client>` leg is still ringing, what exactly is billed?
> 6. Media Streams ($0.0044/min): is it billed per started minute of stream duration? Per stream or per track? And does billing stop when our WebSocket closes, or only when the call ends?
>
> **B. Hard spending controls**
>
> *Why we ask: we need to know the maximum we can be billed if our own servers fail.*
>
> 7. Is there any account-level or subaccount-level hard spend cap for voice that refuses new calls? Or is UsageTrigger plus our own action the only mechanism?
> 8. At a zero prepaid balance with auto-recharge off:
>    - Are new inbound calls refused, and with which SIP response on a BYOC trunk?
>    - Do in-progress calls continue until they end?
>    - Is there a maximum negative balance, or a time after which live calls are ended?
> 9. Can auto-recharge be enabled or disabled through the API? Can a restricted (non-Main) API key do it?
> 10. Suspending a subaccount through the API: your documentation says in-progress calls do not end. Please confirm. Are new inbound BYOC calls then refused immediately? Does suspension affect BYOC trunks in that subaccount?
> 11. What is the typical and worst-case delay between usage happening and a UsageTrigger firing for voice and Media Streams categories? Is a call counted before it completes?
>
> **C. Numbers**
>
> *Why we ask: our model swings by about 25 contribution points on this.*
>
> 12. Our invoices show about £0.87 a month for each UK number. Your GB page now lists local numbers at $3.50 and mobile at $2.50 a month.
>     - Which price applies to our existing numbers at their next renewal?
>     - Which price applies to new purchases?
>     - Is there a separate price for UK **national (03)** numbers?
>     - Is any change scheduled?
>
> **D. What reaches our webhook on BYOC calls**
>
> *Why we ask: we need to know which line forwarded the call.*
>
> 13. Your SIP documentation says custom X- headers on INVITEs from BYOC trunks are discarded. Is `Diversion` (or `History-Info`) on a BYOC INVITE mapped to the `ForwardedFrom` parameter, or passed in any other parameter?
> 14. Our carrier sends `From` in UK national format (`07…`) and the Request-URI user as `44…` without a plus. How do `From`, `To`, `Caller` and `Called` appear in the webhook for BYOC calls? Do you normalise them to E.164?
> 15. Are BYOC webhooks signed with `X-Twilio-Signature` using the auth token of the account (or subaccount) that owns the trunk, exactly as for hosted numbers?
> 16. Is `StirVerstat` ever populated on BYOC calls?
>
> **E. Capacity, routing and region**
>
> *Why we ask: an overflow must fail safely and audibly.*
>
> 17. Is there a concurrency or calls-per-second limit on **inbound** BYOC calls? What SIP response does the carrier receive when it is exceeded, so we know what the caller hears?
> 18. For a UK carrier, should we use the `ie1` termination URI? If we do, must webhooks and API credentials use the IE1 region? Or can a US1 account use the Dublin edge for BYOC termination?
> 19. Do UK-carrier numbers delivered over BYOC need a regulatory bundle or address in Twilio? Do they need to be registered as Twilio phone-number resources, or does the trunk's Voice URL handle every called number?
>
> **F. Fraud controls**
>
> *Why we ask: our product never places outbound calls.*
>
> 20. If a BYOC trunk has no origination connection policy, can any API or TwiML path place an outbound call over it?
> 21. For BYOC termination, do you recommend IP ACL **and** credentials when the carrier's signalling IPs are shared with its other customers?
>
> **G. Commercial**
>
> 22. Is there any minimum commitment, setup fee or contract term for BYOC? Is any volume discount available at about 200,000 minutes a month?
>
> Thank you.

---

## 2. Magrathea (reply on ticket LKV-51353-279, to Ben)

**Subject:** Re: LKV-51353-279: follow-up questions before a live numbering account

> Hi Ben,
>
> Thank you again for the written answers (REFER not supported, inbound free, £100/month minimum, limits do not end live calls). Before deciding on a live account, we have the questions below. Our likely design routes each of our numbers to a third-party SIP platform (Twilio BYOC), or to our own SIP server, and never makes outbound calls.
>
> **A. Commercial terms**
>
> *Why we ask: these decide when Magrathea becomes cheaper than our current provider.*
>
> 1. Does the £100/month minimum count number rentals (£0.50/number) and usage, or is it a fixed fee on top? Is it per account? What is the minimum term and notice period?
> 2. Please confirm that inbound calls to numbers routed to SIP stay free at 1,000–10,000 numbers and about 2–3 million minutes a month. When would capacity-based or channel charging apply?
> 3. Do you offer a reduced or waived minimum while we ramp up, for example until a subscriber threshold?
> 4. Are 01/02 geographic numbers available on the same terms as 03? Is any range restricted for consumer forwarding use?
>
> **B. Channels and overflow**
>
> *Why we ask: your channel limit would be the only provider-enforced cap on our per-minute spend.*
>
> 5. The trial allows 2 channels per number, and we understand live numbers have 10. Can we set a **lower** channel limit per number (for example 2)? Can we also set an **account-wide** concurrent-call cap across all our numbers? How quickly can either be changed, and can we change it ourselves?
> 6. When a number's channel limit is reached, what does the next caller hear (busy, or a recorded message)? Does the call fail over to the number's second target?
>
> **C. Routing to Twilio**
>
> *Why we ask: this decides whether we can avoid running our own SIP edge.*
>
> 7. Can a number's SIP target be an FQDN, such as `ourname.sip.ie1.twilio.com` (a Twilio BYOC termination domain that resolves to several IPs)? Or must it be an IP address? Which target prefixes support TLS/SRTP (the `E:` target in the NTSAPI guide)?
> 8. Can your platform answer a 407 digest challenge, that is, authenticate to the far end with a username and password? If not, from which source IP ranges should a far end expect your INVITEs? Are those IPs shared with other customers' traffic?
> 9. What Request-URI user format do you send (we saw `443300884327`)? Can the `To`/Request-URI be sent as `+44…` E.164?
> 10. With up to 3 targets and 20 s sequential failover: which responses trigger failover (no response, 5xx, 486, 603)? After the last target fails, what does the caller hear?
>
> **D. Identity and forwarding headers**
>
> *Why we ask: these decide whether we can confirm that a customer's forwarding is set up, and whether shared numbers are safe.*
>
> 11. Is `Diversion` (your CDR `LDLI`) populated on calls diverted from EE, Vodafone, O2, Three and their MVNOs? Does it differ by divert type (unconditional, busy, no-reply, not-reachable)? Does `reason=` ever carry the divert type? (We saw `reason=unknown`.)
> 12. Is RPID `screen=yes` set by your network after verification, or passed through from upstream? Can a VoIP-originated caller set `From`, RPID or `Diversion` values that reach us unchanged?
> 13. Under the Network Mode agreement, would INVITEs carry `P-Asserted-Identity`? What does that agreement involve?
> 14. May we use `Diversion` internally, never displayed to anyone, to match a call to the customer whose phone forwarded it (Schedule 3 §5)?
>
> **E. Delivery options**
>
> 15. Can a number target a UA **registered** to your SIP gateway, instead of a public SIP URI? Do you offer any WebRTC or app-delivery product?
> 16. What is the mobile product you mentioned as in testing (SIMs, 07 numbers, porting, per-call routing)?
>
> **F. Fraud and spend controls**
>
> 17. Can our outbound trunk 112168 be fully barred, or reduced to 0–2 channels with UK-mobile-only destinations and IP-locked authentication, so that the account can never originate a call?
> 18. On a live account, does an exhausted prepaid balance stop new chargeable calls? Are there low-balance alerts or daily/monthly caps? Is there a near-real-time CDR or balance API?
> 19. For a receive-only service, is Schedule 5 (999 access) required?
>
> **G. Numbers, porting and the trial**
>
> 20. Can you port in UK geographic or 03 numbers currently hosted by Twilio? Can numbers allocated by you be ported out later?
> 21. Our REST `/number/*` calls return 401. Which interface and credentials should we use to change a number's target and for `DEAC`? Please confirm in writing when 0330 088 4327 no longer targets our test server.
> 22. Could you send the CDR durations and debits for `6AC7C417GF374B24`, `6AC7DA6BAF3B522D`, `6AC7DE025F3BB2F9`, `6AC7DF255F3BD120` and `6AC8BAC7JF4CE809`?
>
> Many thanks,
> Andrew

---

## 3. AQL (email to the contact from the earlier call)

**Subject:** Follow-up to our call: rate card and inbound/routing questions

> Hello,
>
> Thank you for the call and for sending the rate card.
>
> **Rate card**
>
> 1. Could you re-send the rate card (the version you sent after our call) and confirm it is current? We want to make sure we are modelling the right figures.
>
> **Inbound pricing for geographic numbers**
>
> *Why we ask: we need to compare you with other inbound carriers.*
>
> 2. For UK geographic (01/02) and 03 numbers receiving calls forwarded from UK mobiles and delivered to our SIP server, what are:
>    - the number rental;
>    - the inbound per-minute charge (if any);
>    - any channel or concurrency charge;
>    - setup fees;
>    - the minimum monthly commitment and contract term?
> 3. How many concurrent calls does each number or account support? Can we set a hard account-wide cap? What does a caller hear when it is reached?
>
> **Network-level routing on aql SIMs**
>
> *Why we ask: this is the only route where family calls would never touch a paid leg.*
>
> 4. With your MNO status via BlueWave: for a subscriber on an aql SIM, can your core apply a per-subscriber rule before the handset rings, such as "deliver directly unless the caller is not on list L, in which case divert to SIP URI X"? Through what API, and at what latency for list updates?
> 5. Under that rule, are calls from listed (trusted) callers delivered to the handset without any inbound or diversion charge to us, that is, never billed to us?
> 6. Where unknown callers are diverted to our SIP server, which headers carry the subscriber's number (`Diversion`, `History-Info`, `P-Asserted-Identity`)? Is the caller's CLI network-verified?
> 7. Does it work for iPhone and Android on VoLTE and VoWiFi? Can customers port in their existing mobile number?
> 8. What are the per-SIM wholesale price, the minimum volume and the contract term?
>
> **Controls and commercial**
>
> 9. Can outbound be barred at account or trunk level, and can traffic be IP-allowlisted? Do any prepaid or spend limits end calls already in progress?
> 10. What are the onboarding steps, due diligence and lead time for a small UK start-up?
>
> Kind regards,
> Andrew

---

## 4. Which decision each question unblocks

**Decisions:**
- **D-R1:** go or no-go for the Magrathea → Twilio BYOC variant (B1 minimal).
- **D-PRICE:** £5.99 vs £7.99 cohort price, and the day-45 checkpoint.
- **D-EDGE:** whether an HCG SIP edge is required.
- **D-POOL:** whether pooled numbers (C′) are viable.
- **D-BOUND:** written acceptance of the residual spend exposure.
- **D-MIG:** the number migration approach.
- **D-NUM:** the number-rental assumption.
- **D-AQL/E:** whether the network-partner track is real.
- **D-DEL:** the direct-to-app (B2) scope.

| Provider | Questions | What they establish | Decision unblocked |
|---|---|---|---|
| Twilio | 1–3, 5 | BYOC/SIP/SDK stacking; per-minute vs per-second; ringing | **D-R1**, **D-PRICE** (B1 contribution 27–50%; A 9–34%) |
| Twilio | 4 | `<Reject>` billed £0 | D-BOUND (refusal is the Fortress's last resort) |
| Twilio | 6 | Media Streams billing basis | D-PRICE, D-EDGE (an edge removes Streams) |
| Twilio | 7–11 | Spend cap, zero balance, auto-recharge API, suspension, trigger latency | **D-BOUND** |
| Twilio | 12 | £0.87 vs $3.50 rental | **D-NUM**, D-PRICE, D-MIG (Magrathea £0.50) |
| Twilio | 13–16 | Diversion on BYOC, number formats, signature, STIR | **D-EDGE** (no Diversion means an edge is needed to read it), D-R1 (code changes) |
| Twilio | 17–19 | Inbound concurrency, region, number registration | D-R1 (configuration), D-BOUND |
| Twilio | 20–21 | No outbound path; authentication | D-BOUND, D-R1 |
| Twilio | 22 | Minimums | D-R1 |
| Magrathea | 1–4 | Minimum, free inbound at volume, ramp-up, 01/02 | **D-R1**, D-PRICE, D-POOL |
| Magrathea | 5–6 | Per-number and account channel caps; overflow | **D-BOUND** (the provider-enforced concurrency bound), D-POOL |
| Magrathea | 7–10 | FQDN/TLS target, digest auth, URI format, failover | **D-EDGE**, D-R1 |
| Magrathea | 11–14 | Diversion per network and divert type, spoofing, PAI, permitted use | **D-POOL**, D-EDGE, LF-2 passive proof |
| Magrathea | 15–16 | Registered UA / WebRTC; mobile product | D-DEL, D-AQL/E |
| Magrathea | 17–19 | Outbound barring, live prepaid stop, CDR API, 999 | D-BOUND, D-R1 |
| Magrathea | 20–22 | Porting, DEAC/REST access, CDRs | **D-MIG**, trial teardown, billing proof |
| AQL | 1–3 | Rate card; inbound DDI pricing; caps | D-AQL/E, D-R1 (alternative to Magrathea) |
| AQL | 4–8 | Trusted calls released or never billed on aql SIMs; headers; iPhone; SIM price | **D-AQL/E** |
| AQL | 9–10 | Controls; onboarding | D-AQL/E, D-BOUND |

**Suggested order:** Twilio and Magrathea first (both £0, and together they decide R1). AQL is in parallel, because it is a long-track option.
