# UX Review: APP_VISUAL_SPECIFICATION.md against two real personas

STATUS: Review only. Findings below, revised after your follow-up guidance broadening the target market beyond older users — Home Call Guard is positioned for three overlapping groups (individuals ~25–55, adult children/relatives ~35–65 managing protection for someone else, and older customers using it directly), and the product must read as a modern, premium, universally-accessible consumer product, never as something visibly designed for elderly users specifically.

**A CALIBRATION NOTE, added after the original review:** a few of the recommendations below, as first written, over-corrected for a single-persona ("assistive tool") read rather than universal design — these are marked **REVISED** with the corrected recommendation, not deleted, so the reasoning stays visible. The remaining findings hold up unchanged: they were never age-specific in the first place, just findings that happened to surface most clearly when reviewing through an older-user lens.

Originally reviewed from two personas: **(1) a non-technical older user using the app themselves**, and **(2) an adult child setting the service up for a parent.** Findings are organised by severity, with the screen ID(s) affected and a concrete proposed fix for each — not just a list of concerns.

---

## Most significant finding: a genuine logical conflict, not just a UX rough edge

**B4 (Activation instructions) assumes the customer has a free hand and a second channel of attention while dialling the forwarding code. This breaks down completely in the most common real version of Persona 2.**

If an adult child is remotely talking their parent through setup over a phone call (not physically present with them), the parent has only **one phone**. That phone is currently occupied by the call with their child. B4 asks them to open the Phone app and dial a code — which means **hanging up on the person walking them through it**, at exactly the step where guidance matters most. This is a real, concrete, physical contradiction in the current flow, not a copy problem.

**Proposed fix:** B4's instructions must explicitly acknowledge this scenario: *"If you're on the phone with someone helping you, you may need to put them on speaker, or ask them to call you back on a landline or another phone while you dial this."* This is a one-sentence addition, but it's the difference between a flow that quietly fails for a very common real scenario and one that doesn't.

---

## Persona 1: older customer, non-technical, setting up and using the app alone

(One of three target segments, not the design centre of gravity for the app as a whole — see the calibration note above. Findings below are worth designing for as good universal practice, not as visible "elderly mode" treatment.)

### High severity

1. **A3 (Register) — password creation is friction worth removing, but not by changing the masking default.** **REVISED:** the original recommendation to default the password field to visible text was an over-correction — masked-by-default with an easy show/hide toggle (already in the spec) is the correct universal pattern across all three segments; unmasking by default would look like a security oversight to the 25–55 segment and is unnecessary given the toggle already exists. The real fix, which holds up for every segment and is worth prioritising: **offer Sign in with Apple / Google as the primary path**, with email/password as the fallback. This isn't an accessibility accommodation — it's what a modern consumer app is expected to offer, and it removes password creation/recall friction for everyone, not just anyone in particular.

2. **A4 (Confirm your email) — assumes fluent, frequent email use.** This genuinely varies more by individual habit than by age, but it's a real, common enough pattern (infrequent email checking, uncertainty about which app is "their email," shared email accounts) to design for rather than assume away. Leaving the app for an unfamiliar task with no return guarantee is a real drop-off point for any customer it applies to. **Proposed fix:** show the actual email app icon(s) likely on their phone ("Look for an email from us in Mail or Gmail"), and consider — as a product question, not just a copy fix — whether SMS-based confirmation is viable instead, since a phone number is already central to this product. Flagging this as worth a real product decision, not something to silently work around in copy alone.

3. **B4/B5 (Activation) — no mention of what the customer *hears* after dialling.** Carrier confirmation of a forwarding code is typically an audio tone or a short recorded voice message, not silence. If unmentioned, an anxious first-time user may think something went wrong the moment they hear an unexpected sound. **Proposed fix:** add one line to B4: *"After dialling, you may hear a beep or a short recorded message confirming it — that's normal, you can hang up."*

4. **B5's fallback verification method ("call your own number from another phone") assumes a second phone exists.** For someone whose only phone is the one being protected, this instruction is simply undoable. **Proposed fix:** the primary verification path should not depend on the customer owning a second device — either a server-initiated test call, or accepting that verification may take longer (waiting for the first real unknown caller) with honest copy to that effect, rather than an instruction that quietly assumes a resource not every customer has.

### Medium severity

5. **B3 (Device & provider picker) auto-advances on tap with no confirmation.** For someone unsure they tapped the right icon, a screen changing on its own before they've decided they're sure is unsettling, not efficient. **Proposed fix:** a brief visual confirmation (a checkmark or highlight) before advancing, or replace auto-advance with an explicit "Continue" button — removing the one moment of "did the app just do something I didn't ask for?"

6. **B2 (Membership/Subscribe) hands off to an external browser for payment with no transition framing.** Leaving the app's visual context for an unfamiliar payment page can read as "did the app just break, or is this a scam page?" — a serious concern for an audience being specifically protected from scams. **Proposed fix:** a one-line transition message before the handoff ("You'll now securely complete payment with Stripe, our payment partner — you'll come straight back here after"), and ensure the in-app browser retains visible app branding, not a bare system browser chrome.

7. **C2 (Trusted Contacts) — swipe-to-delete.** **REVISED:** the original recommendation to drop swipe-to-delete entirely was an over-correction — it's a standard, expected, well-understood gesture in mainstream consumer apps (Mail, Messages, WhatsApp) for the 25–65 segments, and removing it would make the app feel dated to them. The spec's original approach was already correct: **keep swipe-to-delete, and always keep an equally visible explicit delete affordance alongside it** (never swipe-only) — this serves every segment simultaneously rather than picking one gesture model for all.

8. **D3 (Support) — accordion FAQ rows.** **REVISED:** the original recommendation to permanently expand all FAQs was an over-correction — accordions are a completely standard, expected pattern in modern consumer apps and would look unpolished if abandoned. The real fix is simpler and benefits everyone: **make the entire row tappable, not just a small chevron icon**, and use a clear, large "+"/"–" affordance — the discoverability problem was about small tap targets, not the accordion pattern itself.

9. **No mention of text-size/font-scaling support (Dynamic Type on iOS, font scale on Android) anywhere in the spec.** This is one of the single highest-impact accessibility decisions for this exact persona and was missing as an explicit requirement. **Proposed fix:** add as a cross-cutting requirement applying to every screen — the app must respect system font-size settings, not fix its own type scale.

10. **B7 (Contact picker) — search field.** **REVISED:** the original recommendation undersold this — search is genuinely necessary for the 25–55 segment, who commonly have large (100+) contact lists, not just a nice-to-have for anyone who types slowly. Keep search prominent; the correct universal design is simply that **the full list is always visible and scrollable underneath it**, so search is additive for people with large lists rather than a gate anyone must pass through first.

### Lower severity

11. **E4 (Session expired)'s copy ("Please log in again to continue") could read as alarming or, worse, suspicious** — an audience being trained to distrust unexpected requests to re-enter credentials could reasonably hesitate at exactly this message, which is an uncomfortable irony for a security product. **Proposed fix:** make this genuinely rare in practice (long-lived sessions, similar to how banking apps keep trusted devices signed in) and, when it does happen, use specific, calm copy ("For your security, please sign back in — this happens occasionally, and everything you've set up is safely saved") rather than a bare instruction.

12. **Bottom tab bar labelling isn't specified.** **Proposed fix:** state explicitly that tabs always carry text labels alongside icons, never icon-only — a small spec gap worth closing rather than leaving to implementation-time assumption.

---

## Persona 2: adult child setting up the service for a parent

Beyond the activation-call conflict above (the most serious finding), the specification as written implicitly assumes **one person, one device, one identity** throughout — it has no answer for several questions that are central to the stated "family member protecting a parent" use case:

### High severity

1. **Whose email address owns the account?** If the parent doesn't use email confidently, the natural real-world behaviour is for the adult child to register the account under *their own* email. But the spec's flow (A3 → A4 → B-flow) assumes whoever registers is also the one who'll subsequently log in on the protected phone day-to-day. If the child registers with their own email but the app needs to be logged in *on the parent's phone*, the parent would need the child's password to ever log in themselves — or the child must always be present to unlock the parent's phone's app session. **Proposed fix:** this needs an explicit product decision, not a UI patch — either (a) support a genuinely separate "family member" role that can view a relative's status from their own login without sharing credentials (a real, if larger, feature), or (b) accept v1 doesn't support this and say so plainly in a support article, rather than leaving customers to discover the limitation by trial and error.

2. **No remote/shared visibility exists anywhere in the spec.** The stated target audience explicitly includes "family members protecting parents or relatives," but every screen in C (daily use) assumes whoever's looking at the app is standing in front of the protected phone. An adult child who set this up has no way to check on their parent's status from their own phone afterward. **Proposed fix:** flag this clearly as a known v1 gap rather than an oversight — worth an explicit decision on whether "shared/family visibility" is a deliberately deferred feature (acceptable) or something that should be scoped into Phase 2 from the start, given how central this persona was in your own brief.

3. **Payer identity vs. protected-phone identity isn't addressed.** If the adult child pays (their card, via B2's Stripe Checkout) but the parent's phone/number is what's protected, does the household model support "my payment, someone else's protected number"? This may already be true of the existing web platform (worth checking against `households`' actual data model rather than assuming), but the mobile spec surfaces it more tangibly, since B2–B5 reads as one continuous flow performed by one person on one device — worth an explicit note either confirming this already works or flagging it as a real constraint to design around.

### Medium severity

4. **No "assisted setup" mode is designed for the case where the child *is* physically present with the parent** (as opposed to remote) — a genuinely easier scenario than the remote case above, but still worth a small, explicit acknowledgment in B1's "Setup welcome" copy (e.g., "Setting this up for someone else? That's fine — just use their phone for the steps below") rather than leaving the copy silently written as if the account-holder and phone-owner are always the same person.

5. **Support (D3) has no path for "I'm helping my parent and need to speak to you on their behalf."** Data-protection/account-ownership questions are a real, common friction point in exactly this scenario (a support agent may reasonably need to verify they're speaking to an authorised person). **Proposed fix:** worth a single line in D3's copy setting expectations ("If you're calling on behalf of a family member, that's no problem — just let us know"), which costs nothing to add and heads off a real point of friction.

---

## Summary of proposed changes, by priority

**Do before Phase 2, regardless of anything else:** the B4 speaker-phone/second-device acknowledgment (the logical-conflict finding), the B5 second-device assumption in verification, and an explicit product decision on the email-ownership/shared-visibility questions in Persona 2 — these three are not polish, they're gaps that would cause real setup failures for the exact customers this product and this app are for.

**Strongly recommended, moderate effort:** Sign in with Apple/Google (now the primary vehicle for reducing password friction, not the masking change originally proposed), the payment-handoff transition copy, larger accordion tap-targets in D3 (not removing accordions), font-scaling support as a stated requirement.

**Worth doing, low effort:** the carrier-confirmation-sound line in B4, the B3 confirm-before-advance behaviour, tab-label requirement, the support-on-behalf-of-a-relative copy line.

**Reversed after the market-positioning refinement (kept swipe-to-delete, kept masked passwords, kept accordion FAQs, kept search-first in the contact picker)** — see the three items marked REVISED above for the corrected reasoning in each case.

Waiting for your decision on which of these to fold into `APP_VISUAL_SPECIFICATION.md` before Phase 2 begins — happy to update the spec directly once you've told me which findings you want incorporated.
