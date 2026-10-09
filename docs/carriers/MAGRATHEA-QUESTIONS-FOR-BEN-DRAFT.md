# Draft email to Ben (Magrathea), ticket LKV-51353-279

**Status:** DRAFT for Andrew to review and send himself (decision D1, 2026-10-09). Nothing has been sent automatically. No personal phone numbers are included.

---

**Subject:** Re: LKV-51353-279 – follow-up questions on the HCG SIP trial

Hi Ben,

Thank you for the detailed answers. They were very helpful. For context: we have parked a live account for now at our current volumes, but would like to keep Magrathea as a future option. A few remaining questions would let us model that properly:

**1. Ending calls that are already connected**
- Is there a maximum call duration for outbound calls (per call or per account), and can we set it ourselves?
- If we request an RFC 4028 session timer on an outbound call and stop refreshing it, do you clear the call and stop billing at expiry? What minimum Session-Expires / Min-SE do you accept?
- Do you clear calls after a period of no RTP? If so, after how long?
- Can your support team or API clear a specific in-progress call (for example by CDR reference), and how quickly?

**2. Billing detail**
- After the £0.01 minimum, is outbound billed per second or per minute? Is there a connection charge?
- Are the quoted prices ex VAT, and does £0.0069/min apply to all UK mobile networks, including MVNOs?
- Are ringing/early media, unanswered or failed calls ever charged?
- What are the trial-account outbound rates?
- Could you send the CDR durations and charges for: 6AC7C417GF374B24, 6AC7DA6BAF3B522D, 6AC7DE025F3BB2F9 (did this one end at our BYE at 18:16:47 UTC on 8 Oct?), 6AC7DF255F3BD120 and 6AC8BAC7JF4CE809?

**3. Commercial arrangement**
- Is the £100/month a minimum spend that inbound, outbound and number rental count towards, or a fixed fee on top? Is it per account or per number range?
- What are the number rental, setup fees, contract term and notice period?
- Do you offer a start-up, ramp-up or low-volume arrangement, for example a reduced or waived minimum until a subscriber threshold?

**4. Bridging and transfer (information only; we are not planning to build this now)**
- Is it permitted for our server to answer an inbound call and place a second outbound call to the customer's UK mobile, bridging the two? Are there acceptable-use limits?
- On such an outbound call, may we present the original caller's CLI? What does the Network Mode agreement involve, and does it include P-Asserted-Identity?
- Apart from REFER (which you confirmed is not supported), do you follow a 302 redirect from our endpoint, or offer any provider-side transfer or "connect to" service? How would each be billed?

**5. Restricting outbound use**
- Can an outbound account be restricted to UK mobile ranges only, with a channel limit and IP-locked authentication?
- Does a live account stop new chargeable calls when prepaid credit is exhausted, as the trial does? Are there low-balance alerts or daily/monthly caps?

**6. Caller and forwarding identity**
- Is the Diversion header populated for diverted calls from EE, Vodafone, O2 and Three (we have only tested Lebara), and which reason values do you pass? We received reason=unknown for a busy divert.
- Is Remote-Party-ID "screen=yes" your own network verification, or passed through from upstream?

**7. Trial number**
- We'd like to keep the trial number pointing at our test server for now. When we finish, which interface and credentials should we use for DEAC (our REST /number/* calls return 401)? What does a caller hear afterwards? Would you confirm in writing once 0330 088 4327 no longer targets our server?

Many thanks,
Andrew
