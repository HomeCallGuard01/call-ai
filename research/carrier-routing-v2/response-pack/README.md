# Provider response pack

Paste provider replies here and get an immediate classification. **Nothing in this folder contacts anyone.** Follow-up questions are drafts for Andrew to send himself.

## Use

```sh
cd research/carrier-routing-v2/response-pack
cp responses.template.json responses.json          # once; responses.json is your working copy
# edit responses.json: for each question set "answer" and paste the provider's words into "excerpt"
node classify.mjs responses.json > CLASSIFICATION.md
```

Answers: `YES`, `NO`, `PARTIAL`, `UNCLEAR`, `UNANSWERED`. Commercial fields take text with units (e.g. `"£0.50/number/month at 1k"`); blank = still missing.

**Before committing `responses.json`:** provider replies may contain names, direct phone numbers or commercial terms marked confidential. Strip those, or keep the file out of git.

## What the classifier outputs

| Output | Meaning |
|---|---|
| **POC 1 verdict** | `NOT NEEDED` only if a provider confirms caller-based routing for customers who keep their SIM (AQL-1, TWI-1, or MNO-1 on all three networks). Otherwise `STILL NEEDED`, with the reason: per-network removal, SIM-route optionality, or network answers that narrow it |
| **SIM-switch routes** | aql SIM, FMC SIM, Telnyx Mobile Voice: "All conditions confirmed" only when every gating question is YES; "Blocked" names the NO |
| **Per answer** | Capability confirmed / ruled out / partly confirmed / not confirmed, architectures affected (decision-report IDs), POC 1 effect, drafted follow-up |
| **Commercial data still missing** | Per provider |

## Question bank (summary)

The full wording and answer rules are in `rules.mjs`.

| Provider | Questions | The answer that matters most |
|---|---|---|
| aql (already contacted; **do not email again**) | AQL-1 scope · AQL-2 per-call hook · AQL-3 signalling-only/£0 · AQL-4 07 port-in · AQL-5 iPhone carrier settings · AQL-6 consumer retail + bars · AQL-7 CFB on 486/603 (Three) · AQL-8 free-inbound DIDs + caps | AQL-1 YES removes POC 1 (not expected). AQL-2…6 all YES = SIM route viable |
| Magrathea (not contacted) | MAG-1 own-range hosting · MAG-2 per-DID caps · MAG-3 diverting identity headers · MAG-4 pre-answer redirect + release · MAG-5 07 hosting · MAG-6 provider-enforced outbound bar | None affects POC 1; MAG-1/2 decide number cost and external bounds |
| Telnyx (meeting 30 Sep, **no written notes found**) | TEL-1 channel billing scope · TEL-2 PSTN release · TEL-3 UK 07 on Mobile Voice · TEL-4 pre-ring webhook (`inbound.interception_app_id`?) · TEL-5 £0 native incoming + iPhone · TEL-6 RN SDK push | TEL-3/4/5 all YES = self-serve SIM route |
| Twilio (Finnian) | TWI-1 what "upstream" means · TWI-2 `<Reject>` unbilled on forwarded calls · TWI-3 ForwardedFrom on CFB · TWI-4 SDK leg on BYOC · TWI-5 hard limits · TWI-6 dial-back CLI | TWI-1 named arrangement removes POC 1; TWI-4 moves every app-delivery cost |
| BT/EE, VMO2, VodafoneThree (one block each) | MNO-1 caller-based CDIV / IMS hook · MNO-2 CFB on handset decline · MNO-3 CLI on divert · MNO-4 forwarding-status API | MNO-1 YES removes POC 1 for that network |
| FMC/MVNO (iQ Mobile, Gamma, Wireless Logic) | FMC-1 signalling-only hook · FMC-2 consumer resale · FMC-3 iPhone · FMC-4 07 port-in | All YES = SIM route viable |

## Paste area (raw replies, before coding them into JSON)

Keep the raw text here so the coded answer can be checked against it.

### aql — reply date: ____
```
(paste)
```

### Magrathea — reply date: ____
```
(paste)
```

### Telnyx — meeting 2026-09-30 notes + written confirmation date: ____
```
(paste)
```

### Twilio — reply date: ____
```
(paste)
```

### BT/EE — reply date: ____
```
(paste)
```

### Vodafone / VodafoneThree — reply date: ____
```
(paste)
```

### Virgin Media O2 — not contacted
```
(paste)
```

### Wireless Logic / Cloud9 — reply date: ____
```
(paste)
```

### iQ Mobile / Gamma — not contacted
```
(paste)
```
