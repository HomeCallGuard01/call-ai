# Home Call Guard — Marketing Facts (verified, 2026-08-23)

Prepared for the marketing/customer-acquisition workstream. Every claim below was checked directly against the live, deployed product (code, live pages, or direct API/DNS checks) on 2026-08-23 — not copied from aspirational docs. Where something could not be verified, it's said explicitly rather than guessed.

## What Home Call Guard does

Home Call Guard is a call-screening service for a home phone (landline or mobile) number. Trusted contacts always ring through immediately, with no delay or check. Calls from anyone else connect as normal, but the line is monitored throughout the call for the spoken patterns of a live phone scam. If it detects one, it can warn a trusted contact by text message and, in the most serious cases, end the call.

**Important, and something marketing must get right**: this is *not* a pre-connect gate that blocks or screens a caller before the phone rings. The call connects, the customer's phone rings and can be answered, as normal — protection works *during* the live conversation, not before it.

## Who it's designed for

People who worry about phone scams targeting themselves or a relative — commonly older or more vulnerable phone users, and the family members/carers who worry on their behalf. It requires no smartphone or app literacy to use day-to-day once set up.

## Price

**£4.99 per month, including VAT.** No long-term contract — billed monthly, cancel any time.

**One caveat marketing should state or at least not contradict**: customers on Sky or Virgin Media landlines may need to add "Call Divert" to their own phone line to complete setup, which can carry a small extra monthly charge from their own provider (around £2.50/month) — this is a third-party telecoms charge, not a Home Call Guard fee, and doesn't apply to mobile-only or other landline customers.

## Is an app required?

**No.** The account, trusted contacts, call activity, and membership are all managed through a plain web dashboard in a browser — no app to download or learn. (A companion mobile app exists in development but is not part of the live customer-facing product and must not be mentioned or implied in current marketing.)

## How the service works, in plain English

1. Sign up and pay online (£4.99/month).
2. Upload the phone numbers of people who should always get straight through (family, friends, GP, etc.) — takes a couple of minutes.
3. Complete a short, one-time setup step on your own phone: dialling a simple code so that calls to your number are routed via Home Call Guard. Full instructions for the customer's specific line are given after signing up.
4. From then on: trusted numbers ring through immediately, every time. Anyone else's call connects as normal, but is monitored live for the signs of a scam call for its duration.

## Trusted contacts behaviour

Customers upload a list of phone numbers they trust. Any call from a number on that list is put straight through, immediately, with no monitoring or delay — protecting the privacy of calls that were never in question.

## Unknown-caller screening / monitoring / scam-risk functionality

Calls from numbers not on the trusted list are connected as normal, but the conversation is monitored in real time for recognised patterns of a live phone scam (for example: pressure to move money quickly, requests for a password or one-time passcode, or attempts to stop the customer speaking to their bank or family). If those patterns are detected:
- A warning text message can be sent to a trusted contact.
- In the most severe cases, the system can end the call to protect the customer.

This is pattern-based live monitoring, not a guarantee. Marketing must not claim scam calls are always caught or that customers are risk-free.

## Cancellation and customer support

- No long-term contract; the subscription can be cancelled at any time via the customer's own account (a "Manage Membership" option that hands off to Stripe's secure billing portal).
- Support is available at **support@homecallguard.co.uk** (real, working mailbox — confirmed via live DNS mail records).

## Privacy/security facts that can be safely stated

- Card payment details are never seen or stored by Home Call Guard — all payment handling is done by Stripe, a major, established payment processor.
- Passwords are stored securely (hashed) by the authentication provider, never stored or seen in plain text.
- Per-call monitoring produces a short technical summary (numbers involved, outcome, timing) for the customer's own call activity view — the specific words spoken during a call are analysed live for scam detection but are not stored/retained afterwards.
- Some service providers used to run the product (payment processing, telephony, cloud hosting, AI transcription) are based outside the UK — normal for a modern online service, and covered in the full Privacy Policy.

## Claims marketing must NOT make

- **Do not** say calls are "screened," "checked," or "blocked" *before* the phone rings — the live product connects the call and monitors it as it happens. ("Screens unknown callers" is fine as a general description; implying a pre-connect gate is not accurate.)
- **Do not** claim or imply a mobile app is available or required — no customer-facing app exists today.
- **Do not** claim 100% scam detection, guaranteed protection, or that a customer "cannot" be scammed while subscribed — this is real-time pattern detection, not a guarantee.
- **Do not** state the £4.99 price as the absolute maximum cost with no caveat — Sky/Virgin landline customers may see a small extra charge from their own provider for a required feature (Call Divert), separate from and not paid to Home Call Guard.
- **Do not** claim calls or their content are recorded or permanently stored — they are not (see Privacy section above).
- **Do not** name specific third-party sub-processors (Stripe, Twilio, Supabase, OpenAI) in customer-facing marketing copy beyond what's already in the Privacy Policy, to avoid the Privacy Policy and marketing drifting out of sync over time.

---

# Demo script (for Age UK, a community group, local press, or a prospective customer)

*A short, spoken-style script — plain language, no jargon, roughly 2 minutes.*

> "Home Call Guard is a service that helps protect you from scam phone calls — the kind where someone rings pretending to be your bank, a family member in trouble, or a delivery company, trying to get you to hand over money or personal details.
>
> Here's how it works. You give us a short list of the people you trust — family, friends, your GP — and their calls always come straight through to you, exactly as normal, no change at all.
>
> When someone *not* on that list calls you, the call still connects as usual — you can still pick up and speak, just like today. But while you're on the phone, Home Call Guard is quietly listening out for the warning signs of a scam call — things like being pressured to transfer money quickly, being asked for a password or a one-time passcode, or being told not to hang up and call your bank. If it hears those warning signs, it can text a trusted family member to let them know, and in the most serious cases, it can end the call for you.
>
> There's no app to download and nothing complicated to learn — you manage everything, including your trusted contacts list, from a simple page in a web browser, or we can help you set that up.
>
> It costs £4.99 a month, there's no contract, and you can cancel any time.
>
> Setting it up takes a few minutes: you sign up online, add your trusted numbers, and then there's one simple thing to do on your own phone — a short code to dial once, so your calls are routed through us. Full instructions are provided, and we're happy to help over the phone if that's easier.
>
> If you'd like to try it, or have any questions at all, you can reach us at support@homecallguard.co.uk."

**Notes for whoever gives this demo**: if asked "does it block the call before I answer?" — the honest, correct answer is no; the phone still rings and can be answered as normal, and protection works during the conversation. If asked about guarantees, be clear this reduces risk, it isn't a 100% guarantee. If asked about an app, be clear there isn't a customer-facing app today — everything is web-based.
