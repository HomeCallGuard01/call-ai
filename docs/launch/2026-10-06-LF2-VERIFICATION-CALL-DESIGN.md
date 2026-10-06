# LF-2 option A: controlled forwarding-verification call. DESIGN ONLY

**Status: proposal for Andrew's approval. Nothing is implemented, enabled or purchased.** It needs the outbound path, a dedicated verification number and new state. Options B + C (no auto-proof, truthful wording) are implemented separately (migration 074, `forwarding_unconfirmed`).

## 1. The problem it solves

HCG cannot tell a forwarded call from a direct dial:
- **any** inbound call to an HCG number stamps `activation_verified_at`;
- Twilio's `ForwardedFrom` carried only the Twilio number on all 184 production calls checked (8 Sep).

Forwarding must therefore be proven **actively**: HCG calls the customer's own phone and observes that call arriving back on the customer's HCG number.

## 2. Definition of genuine forwarding proof

Proof exists only when **all** of the following hold:
1. A verification attempt was created for household *H*, its **current** HCG number *N*, and its recorded protected phone number *P* (the customer's own mobile, confirmed in-app).
2. HCG placed one outbound call **from the dedicated verification caller ID *V* to *P***.
3. Within the attempt window (≤ 60 s from placing), an inbound call arrives **on *N*** with **From = *V***.
4. The attempt is still `pending` and matches *H*, *N*, *P* and *V* exactly.

**Result:** `households.forwarding_proven_at = now()`, `forwarding_proof_method = 'verification_call'`. Set by one SQL function, once (compare-and-set). Anything else is **not** proof:
- no arrival;
- arrival on another number;
- From ≠ *V* (for example, the carrier rewrites the caller ID on diversion);
- a late arrival.

The customer is told plainly, and support follows up.

## 3. Loop prevention (a verification call must never call itself)

- `/voice`: an inbound call with **From = *V*** is handled before every other branch. It only resolves the matching attempt and returns `<Reject/>`. It never `<Dial>`s, never monitors, never reserves call budget.
- *V* is a dedicated Twilio number that is **never** assigned to a household. Its own Voice URL is a static `<Reject/>`.
- The outbound verification TwiML is `<Pause length="N"/><Hangup/>`: no `<Dial>`, no stream.
- *P* must not be any HCG or Twilio number (checked against the inventory). UK mobile ranges only. Premium, international and special numbers are refused (reusing the telephony-abuse number policy).
- At most one pending attempt per household (DB constraint). A second request waits for or reuses the first.

## 4. Bounded cost

- A Fortress reservation in a new category, `verification`, before placing, with a hard `timeLimit` (≈ 20–30 s) on the outbound leg. Billed against a small separate global verification cap (for example £0.50/day), **never** the customer's protection allowance.
- Per household: at most 3 attempts per day and 10 per month. Globally: at most 20 per hour. Over a cap, refuse with a customer-safe message.
- Expected cost: one outbound UK-mobile minimum unit plus one inbound leg (rejected at once). **The Twilio UK mobile outbound rate must be confirmed before enabling** (no rate is assumed here).
- The kill switch, breaker and `HCG_INCIDENT_MODE` `contain` level block new attempts (same incident-mode port as SMS).

## 5. Idempotency and concurrency

- New table `forwarding_verification_attempts`: id, household_id, hcg_number, protected_number_hash, verification_caller_id, outbound_call_sid, state (`pending`/`proven`/`not_forwarded`/`expired`/`refused`), created_at, expires_at, resolved_at, resolution_detail.
  - Partial unique index: one `pending` row per household.
  - Unique `outbound_call_sid`.
- Creating an attempt: one SQL function (advisory lock per household). Checks caps, the kill switch and number policy, then inserts `pending`.
- Resolution: idempotent by `(attempt_id, inbound_call_sid)`. The first match wins; replays are no-ops.
- A sweeper expires `pending` attempts after 120 s (`expired` = not proven).

## 6. Customer experience (draft wording, for approval)

- Home / Setup steps: **"Check my call forwarding"**. Explainer: "We'll make a short test call to your phone. If call forwarding is on, your phone won't ring — the call comes straight to Home Call Guard."
- Proven → the "Call forwarding on" step ticks. Combined with the other gates, the customer can now be **Protected**.
- Not proven → "We couldn't confirm call forwarding. Check your forwarding settings, then try again — or contact us." Conditional forwarding (busy / no answer) will make the phone ring; that case is explained.
- Re-check is offered after an HCG number change, a protected-number change, or on support's request.

## 7. Prerequisites and decisions (before any implementation)

1. **A dedicated verification Twilio number *V*** (a provider purchase: Andrew's approval).
2. **An allow-listed outbound path:** today's egress guard rejects all PSTN/SIP. It needs a narrowly scoped exception (*V* → *P* only, `timeLimit` enforced). Security review required.
3. A carrier behaviour check: does each UK network preserve the caller ID (*V*) when diverting? This needs attended tests with real forwarding on Lebara, giffgaff, Three, EE, O2 and Vodafone. If a carrier rewrites From, that carrier cannot be proven this way.
4. New migration (attempts table + Fortress `verification` category) and flag `FORWARDING_VERIFICATION_ENABLED` (default off).
5. Terms and privacy note (HCG makes a short test call to the customer's number).
6. Tests:
   - a direct dial is never proof;
   - From ≠ *V* is never proof;
   - wrong number or late arrival is not proof;
   - loop guard;
   - caps;
   - concurrency (two simultaneous requests → one attempt);
   - kill switch;
   - replay idempotency;
   - real-PG race test.

**Recommendation:** approve the design, then items 1–3 (number, outbound exception, carrier check) as the next attended staging test with forwarding enabled (T12). Implement behind the flag only after the carrier check shows *V* is preserved on the networks the cohort uses.
