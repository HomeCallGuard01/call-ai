# Twilio and OpenAI containment checklist (for Andrew; NOT executed)

**Status:** prepared 2026-10-04. Nothing on this list has been done. Each step changes or reads a live provider account and needs Andrew's decision at the time.
**Rationale:** `2026-10-04-PROVIDER_FINANCIAL_CONTAINMENT_FINAL.md`.
**Evidence:** for each step, save a dated screenshot or export to `docs/security/evidence/provider-config-2026-MM-DD/`. Redact SIDs past their first 6 characters, and never save a token or secret.

Console menu names change. If a path below differs, use Console search for the bold term.

---

## A. Read and record first (no changes)

1. **Billing → Payment type.** Record whether the account is *Pay-as-you-go* (prepaid) or *Invoiced*. Invoiced has no balance stop, so stop here and tell the integration owner.
2. **Billing → Balance.** Record the current balance and the account currency.
3. **Billing → Auto-recharge.** Record ON/OFF, the threshold and the refill amount.
4. **Account → Subaccounts.** Record the count (expected: 0).
5. **Account → API keys & tokens.**
   - List every key: name, type (Main/Standard/Restricted), created date.
   - Mark which one is `TWILIO_VOICE_API_KEY_SID`.
   - Do **not** delete anything yet.
6. **Account → Users / Manage users.**
   - List users, their roles, and 2FA status.
7. **Phone Numbers → Active numbers.**
   - Count (expected: 10 after the 2026-09-30 release).
   - For each number, record:
     - Voice URL
     - **Voice fallback URL** (expected: empty today)
     - Messaging config
8. **Voice → TwiML Apps.** For the app in `TWILIO_VOICE_TWIML_APP_SID`:
   - Record the Voice URL (expected: production `/voice`).
   - Record the fallback URL.
9. **Usage → Triggers.** Record the count (expected: 0 on 2026-09-27).
10. **Monitor → Events.** Filter on geographic permission changes over the last 90 days and record any.

## B. Balance stop (the only Twilio-side ceiling)

11. **Billing → Auto-recharge → Cancel auto-recharge.**
    - If the Console refuses (support plan or short codes), record that. The balance stop is then not available. Escalate.
12. **Billing → Low balance notification.** Set the threshold to about one week of expected spend, sent to Andrew's email.
13. **Decide B**, the prepaid balance HCG is willing to lose in the worst case, and top up only to B.
    - Suggested: 2–3 weeks of expected Twilio spend.
    - Re-top-up manually. Each top-up is a conscious decision.

## C. Outbound and messaging blocks

14. **Voice → Settings → Geo permissions (Voice Dialing Geographic Permissions).** HCG never places outbound PSTN calls, so:
    - Turn **every** country off, **including United Kingdom**: Low-risk numbers, High-risk special services, and High-risk toll fraud.
    - Save.
    - Screenshot GB and the "enabled countries" summary.
    - Note: inbound calls and `<Dial><Client>` are not affected.
15. **Messaging → Settings → Geo permissions.**
    - Enable **United Kingdom only**. Disable every other country.
    - These cannot be changed by API, so this setting is safe even if an API credential is stolen.
16. **Messaging → Settings → SMS Pumping Protection.** Turn it on, if offered for Programmable Messaging.
17. **Voice → Settings → General.** Confirm **24-Hour Maximum Call Duration = Disabled**, which keeps the per-call cap at 4 h.

## D. HCG-down behaviour

18. **TwiML Bins → Create**, named `hcg-fallback-reject`, with this body:
    ```xml
    <?xml version="1.0" encoding="UTF-8"?>
    <Response><Reject/></Response>
    ```
19. **For each active number → Voice configuration → "Primary handler fails"**, set it to the `hcg-fallback-reject` Bin. Do not change the primary Voice URL.
    - Decision: calls during an HCG outage are refused rather than answered with an error. This matches D3 = reject.
    - Numbers bought later by code will **not** get this setting until the code change in FINAL §5 is made. Re-check after every purchase.
20. **TwiML App (step 8):**
    - Confirm the Voice URL is exactly HCG production `/voice`.
    - Set the fallback URL to the same Reject Bin.

## E. Alerts (alert only, never a limit)

21. **Usage → Triggers → Create.** Set both webhook callback (`https://homecallguard.co.uk/webhooks/provider-usage-alert`) **and** email, because the webhook fails exactly when HCG is down.
    - `calls-outbound`, by count, value **1**, daily. HCG never dials out, so any outbound call is an incident.
    - `totalprice`, by price, daily, about 5× a normal day (script default: £15).
    - `totalprice`, by price, monthly (script default: £150).
    - `phonenumbers`, by count, daily: expected count + 2.
    - `sms-outbound`, by count, daily, about 2× the app's company SMS cap.
    - The equivalent is `scripts/provider-usage-triggers.js` (dry run by default). It does not create the `calls-outbound` or `sms-outbound` triggers.

## F. Credentials (plan; execute only after a code change is ready)

22. **Delete unused keys** found in step 5 (keep the Voice SDK key).
23. **Do not rotate the main Auth Token yet.** The backend uses it for REST and for webhook signatures, so rotating it now takes production down. The sequence, after the subaccount and API-key code change, is:
    - create the secondary token
    - deploy validation against both tokens
    - promote the secondary token
    - remove the old token
24. **Users:** remove anyone who does not need access, and confirm 2FA for every user (step 6).

## G. OpenAI (platform.openai.com → Settings)

25. **Billing:**
    - Record the payment model.
    - Turn **auto-reload off**, or set a monthly reload limit.
26. **Organization → Limits:**
    - Set the monthly spend limit.
    - Turn on **Enforce a hard limit**.
    - Screenshot `enforcement: enforcing`.
27. **Project (the one holding `OPENAI_API_KEY`) → Limits:**
    - Set a monthly hard limit at or below the org limit.
    - Turn on **Enforce a hard limit**.
28. **Project → API keys:**
    - Confirm the backend key is project-scoped.
    - Restrict it to the endpoints used: audio transcriptions, and chat completions only if `/process` stays.
    - Set an expiry.
29. **Admin keys:**
    - Create one only for read-only cost reconciliation, if wanted.
    - **Never** put it on Railway: it can remove spend limits.
30. Decide the limit values knowing that **hitting the limit stops transcription** (monitoring goes blind; calls still connect).

## H. Written questions

31. Send Twilio questions Q1–Q12 from FINAL §7 through a support ticket, so the answer is in writing. Save the answers under `docs/security/evidence/`.

## I. After the checklist

32. Update `tests/launch-gate/registry.mjs` C10 and S20 with the evidence paths. Status may move only as the pass criterion in FINAL §8 allows.
