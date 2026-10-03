# research/carrier-routing-v2 — Carrier & Routing Lab

Research and POC preparation only (2026-10-03). Nobody was contacted, no POC was run, no provider or production setting was changed.

Source of truth: *HCG Next-Generation Telephony Architecture — Decision Report* (Claude Doc `758eb0cc-f638-4269-b3ce-327cddba8934`). This folder deepens it.

| File | What it is |
|---|---|
| `CARRIER_ROUTING_LAB.md` | Primary question answered; AQL, Magrathea, Telnyx, Twilio, UK MNOs, number hosting, FMC/MVNO; 10k-customer operations; unknowns |
| `POC1_SPEC.md` | POC 1 design (Android + iPhone), four-network matrix, PASS/FAIL evidence, triggers that make POC 1 unnecessary. **Not authorised, not run** |
| `economics/legs-model.mjs` | Configurable leg-based cost model (rates as data; `null` = QUOTE). `node --test economics/legs-model.test.mjs` |
| `economics/MODEL_OUTPUT.md` | Model output with today's rates |
| `response-pack/` | Template + classifier for provider replies → capability, architecture, POC 1 verdict, follow-up drafts, missing commercial data |
| `sources/` | Desk-research notes with the URLs opened (2026-10-03) |

Related prior work (not duplicated here): `research/telephony/` on `research/telephony-trusted-bypass` (E1 runbook, probe APK, older usage-profile model); `research/viability/` on `research/commercial-network-viability` (carrier technical spec, number sharing/MVNO analysis, portfolio model).
