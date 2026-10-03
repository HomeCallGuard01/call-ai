# Handover — Carrier & Routing Lab (2026-10-03)

## Where

| Item | Value |
|---|---|
| Branch | `research/carrier-routing-v2` |
| Worktree | `/Users/ad/call-ai-carrier-routing-v2` |
| Base | `origin/main` @ `eb43368` (Merge PR #44) |
| HEAD | see `git log -1` (single docs/research commit on top of base) |
| Scope of change | `research/carrier-routing-v2/**` and this file only. No product code, migrations, config or app files touched |

## Source reports reviewed

| Source | Location | Used for |
|---|---|---|
| **HCG Next-Generation Telephony Architecture — Decision Report** (final rev. 2026-10-02) — source of truth | Claude Doc `758eb0cc-f638-4269-b3ce-327cddba8934` (read in full, 1,348 lines) | Architecture IDs, matrix, POC definitions, provider questions |
| Trusted-call bypass research, E1 runbook, probe v0.2, usage-profile cost model, provider questions | `research/telephony/**` on `research/telephony-trusted-bypass` (07a0a38 + uncommitted edits in `/Users/ad/call-ai-telephony-architecture`) | POC 1 design reused, not rewritten |
| Carrier technical spec; shared numbers / split routing / MVNO; decision paper | `research/viability/**` on `research/commercial-network-viability` (89d213c, pushed) | MNO hook spec, number hosting, MVNO facts |
| Provider migration playbook; ADR-0015, ADR-0018 | `docs/research/`, `docs/decisions/` on `docs/acquisition-readiness` | Telnyx meeting context (meeting 30 Sep; outcome unrecorded) |
| Earlier briefs and session records | local Claude Code session history | Confirmed what was said to/by Twilio, aql, Telnyx |
| New desk research (2026-10-03) | `research/carrier-routing-v2/sources/*.md` | Telnyx/Twilio pricing and docs; Android/iOS re-verification; Magrathea/number hosting |

**Telnyx meeting (30 Sep):** no written notes of what Telnyx said exist anywhere found. Treat its outcome as unrecorded; the response pack has a block to record and confirm it.

## Architecture conclusions

1. Trusted calls avoid HCG variable cost **only** if the decision is taken before the call reaches any platform HCG pays for: the **handset** with conditional forwarding (A3/A4/A12), the **core that hosts the number** (A6/A7/A9, needs SIM change + port), or the customer's **own MNO** (A10, not offered). None is proven.
2. Once a trusted call lands on HCG's platform, returning it needs a new leg: the handset is reachable only via the forwarding number (loop) or another identity (a leg HCG pays). **REFER/302 is never the trusted-cost lever**: under **21* it loops; under CFB/CFNRy trusted calls only leak in when busy/unanswered and should be `<Reject>`ed (unbilled on Twilio and Telnyx).
3. Telnyx UK origination **is published** ($0.005/min local number, $0.0032 mobile number); channel billing covers the UK (Zone A, $15→$10/channel/month) with "User Busy" overflow. These make the same legs ~11% cheaper per minute or flat-priced; they do not remove them. Only Telnyx Mobile Voice (a possible pre-ring hook, `inbound.interception_app_id`, undocumented behaviour) could, by becoming the customer's mobile service.
4. Number hosting / own range / porting give **identity and carrier independence** for the unknown path and cut number cost. Magrathea publishes free inbound at £0.50/number/month and can deliver the diverting-line identity Twilio never exposes; hosting an own range costs more and saves nothing per number. Porting the customer's own 07 to an HCG-controlled host moves the trusted leg rather than removing it, and loses native delivery.
5. Every SIM route makes HCG (or its partner) the customer's **mobile provider**: airtime, porting, Ofcom consumer-provider obligations, fraud exposure. That is a different product, not a cheaper back end for a £5–£7 add-on.

## Provider capability matrix (current state)

| Provider | Capability that could remove trusted cost | Status | Removes POC 1 if YES? |
|---|---|---|---|
| aql | Routing for numbers staying on other MNOs (AQL-1) | Expected NO (applies to aql-hosted numbers/SIMs) | Yes |
| aql / BlueWave SIM | Per-call pre-ring hook, signalling-only, 07 port-in, iPhone carrier settings, consumer retail (AQL-2…6) | UNKNOWN | Optional for SIM switchers |
| Twilio | Named arrangement acting before the customer's MNO (TWI-1) | None found; no mobile core product | Yes |
| Telnyx | Mobile Voice pre-ring hook + UK 07 + £0 native incoming + iPhone (TEL-3…5) | Beta; UK unknown | Optional for SIM switchers |
| Telnyx | Channel billing / cheaper per-minute | PUBLISHED | No (moves/cheapens legs) |
| FMC (iQ Mobile, Gamma, Wireless Logic) | Signalling-only per-call hook (FMC-1…4) | UNKNOWN; business-positioned | Optional for SIM switchers |
| BT/EE, VodafoneThree, VMO2 | Caller-based CDIV / IMS AS hook (MNO-1) | Not offered; competing scam products | Yes, per network |
| Magrathea | Free inbound (£0.50/number/month, 10 channels, £100/month min); diverting-line identity in Network Mode; static per-number routing, no pre-answer webhook; own-range hosting ≥ £500 + £100/month | PUBLISHED (undated price annex) | No (unknown path and identity only) |

Full matrix and answer rules: `research/carrier-routing-v2/response-pack/rules.mjs`.

## Economic model

`research/carrier-routing-v2/economics/legs-model.mjs` (7 tests pass). Compares architectures by chargeable legs × billed duration; rates are a data table with status/source; `null` = QUOTE, shown as "≥ known + QUOTE"; quotes inserted via `--rates file.json`. Reproduces the report's illustrations (£7,560 / £15,120 / £30,240 at 100/200/400 trusted min × 10k subs) and the real 239-s call (4 × £0.00756).

| Architecture | Trusted legs on HCG account | Trusted £/min |
|---|---|---|
| A1 today | 2 | £0.0076 (£0.0106 if SDK leg billed at list) |
| A2 Telnyx per-minute (UK local, list) | 3 | £0.0067 |
| A11 SIP + BYOC | 3 | £0.0030 |
| A11 + HCG-owned media | 3 | ~£0.0004 + platform |
| A3/A4, A12, A7/A9 signalling-only, A10 | 0 | £0 |
| A9 media anchored | 1 | QUOTE |

Minutes are illustrations, not HCG forecasts.

## POC 1 specification

`research/carrier-routing-v2/POC1_SPEC.md`: forwarding semantics (CFU must be off; CFB is the mechanism; CFNRy fallback), exact Android APIs (ROLE_CALL_SCREENING; `setDisallowCall(true)+setRejectCall(true)` → REJECT_REASON_DECLINED → 486/UDUB, vendor code UNKNOWN), permissions, Play policy, OEM dependencies, iPhone Silence limits (iOS 27 re-verified), a 28-row four-network × handset × radio-path matrix, exact PASS/FAIL evidence, safety preconditions (Moto E7 is the production device; its **21* must be off). Reuses `E1_RUNBOOK_MOTOROLA.md` and probe v0.2.

## Exact triggers that make POC 1 unnecessary

| Trigger | Effect |
|---|---|
| AQL-1 = YES (aql routes calls for numbers staying on EE/O2/Vodafone/Three) | Not needed (confirm via provider-run trial) |
| TWI-1 = YES (Twilio names an arrangement acting before the customer's MNO) | Not needed |
| MNO-1 = YES on all three UK network groups | Not needed (per network if only some) |
| A SIM route fully confirmed (AQL-2…6, FMC-1…4 or TEL-3…5 all YES) | Optional: still needed for customers who keep their SIM |
| MNO-2 / AQL-7 written answer on CFB-on-decline | Narrows only |

No pricing answer (rates, channel billing, BYOC, own range) changes whether POC 1 is needed. `response-pack/classify.mjs` applies these rules automatically (10 tests pass).

## Remaining unknowns

1. CFB on handset decline per UK network (486/603/UDUB; VoLTE/VoWiFi/2G).
2. iPhone Silence: decline, silent ring, or neither.
3. Any consumer-SIM provider with a signalling-only pre-ring hook + 07 port-in + iPhone carrier settings.
4. Twilio SDK-leg billing on BYOC; permanence of today's £0.
5. Any UK MNO willing to expose caller-based diversion.
6. Whether UK MNOs populate the diverting-line identity on forwarded calls (Magrathea can deliver it if they do); Magrathea mobile product scope.
7. What Telnyx said on 30 Sep; Telnyx Mobile Voice UK availability and `interception_app_id` behaviour.
8. Whether Google Phone's spam filter / Call Screen acts on calls a third-party screener allows; Samsung behaviour.

## Recommended next evidence (in order; each needs Andrew)

1. When aql replies: code it into `response-pack/responses.json`, run `classify.mjs`. Do not send aql another unsolicited email.
2. Twilio: TWI-1 and TWI-4 in writing (Finnian thread already open).
3. Record the Telnyx meeting's answers in the TELNYX block; ask for written confirmation of TEL-1 and TEL-3…5.
4. Optional, Andrew's choice: one network engineer's written answer to MNO-2 (narrows POC 1 cheaply).
5. If no provider removes POC 1: authorise POC 1 per `POC1_SPEC.md` (first network = the Motorola's existing SIM).
6. Only if a SIM route is acceptable as a product: POC 2.

## Confirmations

- **No contact:** no provider, operator, Apple, or any person was contacted; no email, form or message was sent. Follow-up questions in the response pack are drafts only.
- **No POC:** POC 1 and POC 2 were not started. No number bought or released, no forwarding changed, no probe installed, no test call placed.
- **No production/provider changes:** no Twilio, Telnyx, Supabase, Railway, app-store or production change; no deploy, no migration, no merge.
- Desk research used public web pages only (URLs listed in `research/carrier-routing-v2/sources/`).
- Secret scan: see commit notes (run before commit; no credentials, tokens or account SIDs in the added files).
