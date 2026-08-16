# Home Call Guard — How It Works

Home Call Guard is a subscription telephone-protection service designed to help protect people and families from scam calls.

1. **Customer signs up**
   The customer visits the Home Call Guard website, creates an account, confirms their email address and subscribes for £4.99 per month through Stripe.

2. **Protection is provisioned automatically**
   Stripe confirms the subscription to Home Call Guard. The customer entitlement becomes active and Twilio automatically provisions the telephone infrastructure required for that household.

3. **Customer completes setup**
   The customer enters the phone number they want to protect, adds trusted contacts and follows the supplied call-forwarding instructions.

4. **Trusted callers pass normally**
   Calls from trusted family and friends bypass scam screening and are connected normally.

5. **Unknown callers are monitored**
   Unknown callers are screened and monitored for scam behaviours while the call progresses. Home Call Guard uses progressive risk scoring together with specific red-line behaviours such as requests for security codes, safe-account transfers, isolation from family/bank, remote access and other recognised scam techniques.

6. **Home Call Guard can intervene**
   If suspicious behaviour develops, the system can warn the protected customer. If a red-line behaviour is detected, Home Call Guard can terminate the call automatically.

7. **Customer management**
   The customer uses the Home Call Guard dashboard/mobile experience to manage trusted contacts, membership, setup and activity. The protection itself runs in the cloud and does not depend on the website or app being left open.

## Core system flow

**Caller → customer's normal number → Home Call Guard → trusted check → unknown-call screening → live monitoring → continue / warn / terminate**

## Main services

* **Stripe** — subscriptions and billing
* **Supabase** — authentication, households, entitlements and data
* **Twilio** — telephone numbers, call routing, Media Streams and SMS
* **OpenAI** — call screening/transcription/risk analysis
* **Railway** — production hosting
* **Resend** — customer and operational email

## Launch principle

The customer should be able to discover Home Call Guard, understand it, subscribe, complete setup and become protected without direct assistance from the founder.
