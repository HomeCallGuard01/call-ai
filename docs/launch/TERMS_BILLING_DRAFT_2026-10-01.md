# Terms: billing, cancellation and price-change draft (1 Oct 2026)

**DRAFT for Andrew and legal review. Not published, and `public/terms.html` is not changed.**

- The live source is `public/terms.html` on `website/launch-ready-homepage` (`44e2d55`). Section numbers below follow that file.
- **No price is written here.** `[PRICE]` stands for the approved monthly price, which Claude A has not yet decided. See "Price-agnostic wording" for how to avoid needing it in most places.
- Sections marked **PENDING — FINANCIAL-SAFETY DECISION** can't be drafted until the monitored-minute allowance, what happens when it runs out, and the household/company limits are decided. Nothing here defines or implies an allowance.

## Price-agnostic wording (recommended)

The app, web checkout and Stripe Checkout now show each channel's real price at the moment of purchase (`feature/ios-102-dynamic-pricing`).

The Terms can follow the same principle, so a price change doesn't create a window where the Terms state the wrong figure:
- state that the price is the one shown before purchase;
- give the current standard price once, in one clearly dated place;
- refer to that place elsewhere.

The drafts below use this approach.

---

## §3 Subscription, pricing and billing: replacement text

> **3.1 Price.** Home Call Guard is a monthly subscription. The price is shown to you, including VAT, before you subscribe: in the app, on our website, and on the payment page (Apple's or our payment provider's). Our current standard price for new subscribers is [PRICE] per month, including VAT. The Company is registered for VAT in the United Kingdom (VAT registration number GB379120684).
>
> **3.2 How you pay.** You pay in one of these ways, depending on where you subscribed:
> - **Online or in our Android app:** through our payment provider, Stripe. By subscribing, you authorise us (through Stripe) to charge your payment method the monthly price automatically, starting on the day your subscription starts, until you cancel.
> - **In our iPhone app:** through Apple, using your Apple ID. Apple takes the payment, and Apple's own terms apply to it. Your subscription renews automatically unless you turn off auto-renew at least 24 hours before the end of the current period.
> - **Through Google Play** *(only once Google Play billing is available in our Android app)*: through Google, using your Google account. Google's own terms apply to that payment.
>
> **3.3 Failed payments.** If a monthly payment fails, we (or Apple or Google) will retry it, and we'll let you know so you can update your payment details. Your protection continues while payment is being retried. If payment still can't be taken, your subscription will end and protection will stop.
>
> **3.4 Price changes.** We may change the price of the subscription. If we do, the new price applies to new subscribers from the date we choose. If we decide to change the price for existing subscribers, we will tell you at least [NOTICE PERIOD] before your first payment at the new price, and you can cancel before it applies. For iPhone subscriptions, Apple also notifies you, and where Apple requires it, the new price only applies if you agree to it. [OPTIONAL, if Andrew chooses to grandfather: "If you subscribed before a price change, you keep paying the price you signed up at unless we tell you otherwise in line with this section."]

Notes for review:
- **3.2 Apple:** the "24 hours before the end of the current period" wording is Apple's standard auto-renew disclosure; check it against Apple's current App Store terms.
- **3.3 Stripe:** confirm the Stripe retry window (Dashboard → Billing → Revenue recovery) before stating any number of days (decision T5).
- **3.3 Apple:** Apple's billing retry and grace period are configured in App Store Connect. Confirm whether Billing Grace Period is on.
- **3.4 `[NOTICE PERIOD]`:** a legal decision. It must be at least the channel's own notice: Apple sends first notice 27 days before a monthly renewal; Google gives at least 30 days (opt-in); Stripe has no automatic notice, so we notify. A single figure that is ≥ 30 days works for every channel.
- **Grandfathering:** see §8 of `IOS_102_RELEASE_PREP_2026-10-01.md`.

## §3.5 Monitored-minute allowance: PENDING — FINANCIAL-SAFETY DECISION

Placeholder only. Once the financial-safety workstream decides, this clause needs to state:
- what is limited (monitored minutes only? which calls count? does ringing count?);
- the amount per billing period, when it resets, and whether unused minutes roll over;
- what happens to calls when the allowance is reached (the product requirement that calls must never simply stop while forwarding points at HCG must be reflected accurately);
- how and when the customer is told (app, SMS, email);
- whether more can be bought;
- how simultaneous-call or household safety limits appear to the customer.

**Do not publish any wording for this clause until it has been decided.**

## §4 When protection starts: small fix

Today the clause says protection starts "as soon as your payment is successfully processed and confirmed — typically within a few seconds of completing checkout".

- Add: "…or, for iPhone subscriptions, as soon as Apple confirms your purchase to us."
- Also, protection genuinely depends on call forwarding and the app being installed. Decision T4 (decisions doc) already proposes wording, so merge it with T4 rather than duplicating it.

## §5 Cancellation policy: replacement for the "how to cancel" paragraph

> You can cancel at any time, with no minimum term and no exit fee. How you cancel depends on how you pay:
> - **Paid through Stripe (online or Android app):** use "Manage membership" in the Home Call Guard app (Account) or in your online account.
> - **Paid through Apple (iPhone app):** Apple manages the subscription. Cancel in your iPhone's Settings → your name → Subscriptions, or from "Manage subscription" in the Home Call Guard app, which takes you there. We can't cancel an Apple subscription for you.
> - **Paid through Google Play** *(once available)*: cancel in the Google Play app → Payments & subscriptions → Subscriptions.
> - **Complimentary or promotional access:** email support@homecallguard.co.uk from the address on your account.
>
> Cancelling stops future payments. Your protection continues until the end of the period you have already paid for.
>
> **Important: cancelling does not switch off call forwarding on your phone.** When your protection ends, turn call forwarding off (the app shows you how, under Account → "Need to turn protection off?"), or calls to your number may not reach you.

The last paragraph is decision T6. It is a real customer-harm risk: after cancellation and a grace period, calls still forwarded to HCG hear "this call cannot be connected".

## §8 Service availability: calls delivered through the app (T7)

> Calls are delivered to you through the Home Call Guard app, so it needs to stay installed and signed in on the protected phone, with an internet connection and (on first use) permission to use the microphone.

Mentioning the microphone depends on the iOS 1.0.2 microphone-permission work. Drop the phrase if that isn't shipped.

## §9 Fair use: PENDING — FINANCIAL-SAFETY DECISION

- Keep the current wording until the allowance and household limits are decided.
- It must then be aligned with §3.5 so the two clauses don't contradict each other (today "fair use" is the only usage wording customers see).

## §10 Refunds and statutory cancellation: add store refunds

Add after the first paragraph:

> If you subscribed through Apple (or Google Play, once available), refunds for that payment are handled by Apple (or Google) under their own policies. Request one at reportaproblem.apple.com (or through Google Play). We'll help if you contact us, but we can't issue a refund for a store payment ourselves. Your statutory rights are not affected.

Legal review:
- the proportionate-deduction wording for store purchases, where Apple and Google, not HCG, decide refunds;
- the immediate-start consent wording ("I'd like my protection to start right away") under the Consumer Contracts Regulations 2013 (open item since 21 Sep).

## §13 Changes to the Terms

"Continued use = acceptance" is weak for consumers when changes are material. Legal review should consider:
- for material changes, especially price or usage limits: notice plus the right to cancel before they apply (consistent with §3.4);
- "continued use" relied on only for non-material changes.

## Other customer copy to change in the same release

| Location | Change | Status |
|---|---|---|
| Homepage (launch-ready) header price, hero, pricing card, FAQ "Each £4.99 subscription…", meta/OG/Twitter, JSON-LD `Offer.price` | new price | waiting for the price decision |
| 12 `public/guides/*.html` CTAs "£4.99/month incl. VAT" | new price, or remove the amount from the CTA ("Get protected on Android") | waiting for the price decision (removing the amount avoids future edits) |
| `MARKETING_FACTS.md` | new price; allowance wording | price: waiting · allowance: PENDING |
| App Store description / promotional text / IAP description | no price (Apple shows it); allowance line | PENDING (allowance) |
| Google Play description | no price today; allowance line | PENDING (allowance) |
| `terms.html` `TERMS_VERSION` / "Last updated" | real publish date | at deploy |
