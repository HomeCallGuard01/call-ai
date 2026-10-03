# Telnyx / Twilio re-verification: trusted-call cost levers (desk research, 2026-10-03)

Labels: **PUBLISHED** = stated in a provider page or spec I opened. **INFERRED** = my reasoning from published facts. **UNKNOWN** = not documented anywhere I could open.
Currency is USD as published. HCG's current trusted-call cost is about £0.00756/started min, which is Twilio GB "receive calls" at $0.0100/min.

## Correction to earlier findings
- **Telnyx UK origination prices ARE published (PUBLISHED).** They are in the machine-readable price list at telnyx.com/pricing.md, under "Inbound Voice", GB:
  - UK Local and National numbers: $0.005/min (from landline or from mobile).
  - UK Mobile numbers: $0.0032/min.
  - Shared-cost numbers: $0.096/min.
  - Number rental: UK Local $1/mo plus $1 one-off. UK Mobile number $2/mo plus $2 one-off.
  - The telnyx.com/pricing/call-control/gb and /elastic-sip/gb HTML pages do not show GB rows. The .md file does.
- **The UK is in channel-billing Zone A (PUBLISHED).** Zone A is $15/channel/month for 0–10 channels, $14 for 10–50, $12 for 50–250 and $10 for 250+.

## TELNYX

### 1. Channel billing
- **How it works (PUBLISHED, support 8428806 and 1130678):**
  - You set it per number ("Voice Billing Method = Channel").
  - Only numbers from countries in a Channel Zone qualify. The United Kingdom is listed in Zone A.
  - "Channel billing is only applicable for standard DID's. Toll free or international DID's only have the option for pay per minute." It is not clear whether "international" here means outside the zones or non-geographic numbers. The UK is explicitly in a zone.
- **Configuration (PUBLISHED, OpenAPI):** `usage_payment_method` enum `pay-per-minute|channel` on the phone-number voice settings: "Controls whether a number is billed per minute or uses your concurrent channels."
- **What it covers (PUBLISHED, 8428806):** "unlimited inbound minutes". Channel charges appear only as MRC, and "the calls themselves will show up as $0."
- **Above the channel count (PUBLISHED):** "any new inbound call will be rejected with a 'User Busy' hangup cause." Channels are pooled per zone across all channel-billed numbers.
- **Applicability to Call Control / Voice API / TeXML / WebRTC: UNKNOWN.** The articles do not say.
  - **INFERRED:** the setting sits on the number, not the connection, so it likely applies whatever app the number points to.
  - **INFERRED:** it replaces only the SIP-trunking inbound per-minute. pricing.md describes the Voice API $0.002/min as a "Platform fee; SIP trunking fees apply on top", which treats the two charges as separate. WebRTC $0.002/min is also listed as its own line.
  - So with channel billing a Call Control → WebRTC trusted call is still about $0.004/min plus the channel fee.
- **Break-even (INFERRED):** $15 ÷ $0.0032 ≈ 4,700 UK-mobile-number minutes per channel per month. Each channel must also cover peak concurrency. Overflow returns busy, which for a forwarded trusted call means a failed call.

### 2. WebRTC / Voice SDK
- **Push (PUBLISHED, React Native push docs):**
  - iOS: APNs VoIP via PushKit, through `react-native-voip-push-notification`, and incoming calls "must" be reported to CallKit.
  - Android: FCM, handled inside the SDK.
  - Push credentials attach to the SIP Connection's WebRTC settings. There is a limit of 5 push tokens per user.
  - After a push the app must reconnect the socket to receive the actual INVITE.
- **Price (PUBLISHED):** WebRTC origination and termination are each $0.002/min (pricing.md; release note of 2021-03-29). The release note says this is "in addition to any cost associated with PSTN call legs".
- **Voice API fee on the WebRTC leg: UNKNOWN.** It is not stated whether the $0.002 Voice API fee also applies to the WebRTC leg when Call Control dials or bridges to it.

### 3. Call Control: transfer, bridge, refer, answer
- **`transfer` (PUBLISHED, OpenAPI):** "Transfer a call to a new destination". The expected webhooks include `call.initiated` and `call.bridged` for Leg B, so it creates a new leg.
  - **INFERRED:** Telnyx stays in the path and both legs are billed.
- **`bridge` (PUBLISHED):** "Bridge two call control calls." **INFERRED:** both legs stay on Telnyx and are billed.
- **`answer` (PUBLISHED):** "You must issue this command before executing subsequent commands on an incoming call." **INFERRED:** answering starts billing.
- **`refer` (PUBLISHED):**
  - "Initiate a SIP Refer on a Call Control call… at any point in the duration of a call."
  - The only required parameter is `sip_address`, a SIP URI.
  - Price: "Call Control Features SIP Refer $0.1/invocation" (pricing.md).
  - The release note says it transfers "onto a new call to an external destination, without Telnyx in the call path".
- **Refer on a PSTN-originated call: UNKNOWN.**
  - **INFERRED:** Telnyx sends the REFER toward the caller's side. For a PSTN-originated call that side is Telnyx's own PSTN gateway, so the "without Telnyx in path" claim cannot literally hold there.
  - The target must be a SIP URI. The customer's mobile is not SIP-reachable and is CFU-forwarded back to HCG.
- **External transfer (SIP trunking docs, PUBLISHED):** "Telnyx places a new outbound call (A → C)". This is a new leg, so it is billed.

### 4. Media streaming / fork
- **Price (PUBLISHED):** media streaming over WebSocket is $0.0035/min. Raw RTP stream or fork is $0.0025/min (pricing.md).
- **Bidirectional (PUBLISHED):** set `stream_bidirectional_mode=rtp`. Supported codecs:
  - PCMU and PCMA (8 kHz)
  - G722
  - OPUS (8 or 16 kHz)
  - AMR-WB (8 or 16 kHz)
  - L16 (16 kHz)
- **Tracks and timing (PUBLISHED):** tracks are inbound, outbound or both. A stream can be requested on `dial` or on `answer`.

### 5. Reject or redirect before answer
- **TeXML `<Reject>` (PUBLISHED):** "If placed as the very first verb in an incoming call, `<Reject>` will prevent the call from being answered and will incur no cost."
- **Call Control `reject` (PUBLISHED, OpenAPI and reference page):**
  - Causes and SIP codes: `USER_BUSY` (486), `CALL_REJECTED` (603), `NOT_FOUND` (404), `TEMPORARILY_UNAVAILABLE` (480).
  - It only works on unanswered calls.
  - Billing is not stated.
  - **INFERRED:** it is free, consistent with TeXML.
- **SIP 302 redirect handling by Telnyx toward a customer SIP endpoint: UNKNOWN.** I found no documentation.

### 6. Forwarded-call signalling
- **`call.initiated` payload (PUBLISHED, OpenAPI `CallInitiated`):**
  - `sip_headers`: "User-to-User and Diversion headers from sip invite". The `InboundSipHeader.name` enum contains only `User-to-User` and `Diversion`. **History-Info is not exposed.**
  - Also present: `custom_headers` (X- headers), `shaken_stir_attestation`, `shaken_stir_validated`, `caller_id_name`, `call_screening_result`.
- **Diversion on calls from UK PSTN: UNKNOWN.** Whether Diversion is populated for UK PSTN calls that arrive via conditional forwarding depends on the interconnect carrier.
  - Third-party forum reports, which I did not rely on, say Diversion was missing in practice.

### 7. Telnyx Mobile Voice (VoLTE eSIM)
- **Status (PUBLISHED, VoLTE llms-full):** "**Beta** — VoLTE is in beta. API reference and detailed configuration docs coming soon."
- **How it works (PUBLISHED):**
  - "Inbound calls ring the device natively."
  - Call forwarding types are `unconditional`, `no_answer` and `busy`, to "any number — landline, mobile, SIP connection, or Call Control application".
  - A Mobile Voice Connection has `webhook_event_url` and `webhook_timeout_secs`.
  - Inbound Call Screening (flag or reject) is free. Its reputation data covers US and Canada only. SHAKEN/STIR applies to North America only.
- **Pre-ring hook (PUBLISHED schema, behaviour UNKNOWN):** the OpenAPI `MobilePhoneNumber` has `inbound.interception_app_id`, described as "The ID of the app that will intercept inbound calls."
  - This is the only published hint of a pre-ring app decision.
  - No document says whether the app can then let the call ring the SIM natively, or how such a call is billed.
- **Pricing (PUBLISHED):**
  - "Mobile Voice Monthly Recurring Charge $5/sim_card". This sits under the US section of pricing.md.
  - Mobile Voice usage is "determined by a rate deck (not flat)".
  - There is no published incoming per-minute rate.
- **UNKNOWN:**
  - UK availability for SIM-based Mobile Voice. The 2019 "UK mobile voice" release note is about virtual UK mobile numbers, not SIMs.
  - Porting existing UK mobile numbers onto a Telnyx SIM.
  - iPhone VoLTE support.
  - Whether `call.initiated` fires before the device rings.

## TWILIO

### 8. Routing without a Twilio leg
- **Elastic SIP Trunking origination 302 (PUBLISHED, /docs/sip-trunking):**
  - "Your communications infrastructure can redirect an incoming INVITE by responding with a SIP 302".
  - Twilio supports a single redirect and honours only the first Contact.
  - Redirects toward `*.sip.twilio.com` or `*.pstn.twilio.com` are not supported.
  - The redirected call "will use the same egress edge… same Interconnect Connection". Recording and TLS carry over.
  - **INFERRED:** Twilio re-INVITEs the new SIP target itself, so it stays in path and origination keeps billing. The redirect only removes HCG's SBC from the path.
  - Redirect to a tel:/PSTN target: **UNKNOWN** (not documented).
- **GB SIP trunking origination price (PUBLISHED):** Local or Mobile $0.0060/min. That is cheaper than Programmable Voice receive at $0.0100/min, but it has no TwiML or `<Client>`.
- **ESIP REFER transfer billing (PUBLISHED, /docs/sip-trunking/call-transfer):**
  - "Twilio serves as the pivot-point".
  - Transfer of an origination call to PSTN: the parent is billed origination for the parent duration, and the child is billed origination + termination for the child duration.
- **BYOC (PUBLISHED, GB voice pricing):** $0.0040/min to receive and $0.0040/min to make. Browser/app (SDK) is $0.0040/min each way. "SIP interface… $0.1000/refer".
- **Client leg on BYOC-originated calls:** **UNKNOWN** from a page I opened. The Twilio support SDK-pricing article was blocked (Cloudflare 403). A search snippet suggests the "non-Client call leg (parent on inbound calls)" is charged.
  - **INFERRED:** this matches HCG's invoice, where the child Client leg was £0.
- **Twilio Interconnect and Voice Insights:** I opened no page showing either changes call routing or billing. **INFERRED:** neither is a cost lever.

### 9. `<Reject>` (PUBLISHED)
- "allows you to reject incoming calls to your Twilio number without being billed".
- "If the first verb in a TwiML document is `<Reject>`, Twilio will not pick up the call."
- "Using `<Reject>` as the first verb in your response is the only way to prevent Twilio from answering a call. Any other response will result in an answered call and your account will be billed."

### 10. ForwardedFrom, Diversion and History-Info
- **ForwardedFrom (PUBLISHED):** "This parameter is set only when Twilio receives a forwarded call, but its value depends on the caller's carrier including information when forwarding. Not all carriers support passing this information."
- **SipHeader_* parameters (PUBLISHED):** these are documented only for SIP-interface calls (X- headers and UUI).
- **Diversion and History-Info on PSTN calls (INFERRED):** they are not exposed on Programmable Voice for PSTN-originated calls, and no parameter for them is documented.
- **ESIP origination (PUBLISHED):** Twilio *adds* a Diversion header carrying the dialled Twilio number.

## Cost comparison per trusted-call minute (INFERRED from published list prices)

| Path | Per-minute cost | Is HCG still in the path? |
|---|---|---|
| Twilio PV + `<Client>` (today) | $0.0100 | yes |
| Telnyx Call Control + WebRTC, UK **mobile** number | $0.0032 + $0.002 + $0.002 = **$0.0072**, or about $0.0092 if the Voice API fee also applies to the WebRTC leg | yes |
| Same, UK local number | $0.009–0.011 | yes |
| Telnyx with channel billing | about $0.004 + $15 per channel per month. Busy on overflow. | yes |
| Telnyx `refer` | +$0.10 per call. SIP-only target. PSTN applicability unknown. | not useful |
| Twilio ESIP 302 / REFER, BYOC | $0.004–0.006, or both legs billed | yes, Twilio pivots |
| Reject first (either vendor) | $0 | caller is rejected (busy) |

## Sources opened (all on 2026-10-03)
- https://support.telnyx.com/en/articles/1130678-channel-billing
- https://support.telnyx.com/en/articles/8428806-channel-billing
- https://telnyx.com/pricing.md
- https://developers.telnyx.com/pricing.md
- https://telnyx.com/pricing/call-control/gb
- https://telnyx.com/pricing/elastic-sip/gb
- https://telnyx.com/release-notes/webrtc-billing-and-reporting
- https://telnyx.com/release-notes/transfer-calls-with-sip-refer-live
- https://telnyx.com/release-notes/telnyx-launches-uk-mobile-voice-and-messaging
- https://telnyx.com/release-notes/telnyx-mobile-voice-ai-ready-launch (no relevant content)
- https://telnyx.com/products/mobile-voice
- https://developers.telnyx.com/llms.txt
- https://raw.githubusercontent.com/team-telnyx/openapi/master/openapi/spec3.json (CallInitiated, InboundSipHeader, MobilePhoneNumber, MobileVoiceConnection, CallControlApplicationInbound, call command descriptions)
- https://developers.telnyx.com/public/llms/calling/voice-api-full.txt
- https://developers.telnyx.com/public/llms/wireless/volte-full.txt
- https://developers.telnyx.com/docs/iot-sim/call-forwarding-recording (and .md)
- https://developers.telnyx.com/docs/iot-sim/mobile-phone-numbers.md
- https://developers.telnyx.com/api-reference/call-commands/sip-refer-a-call.md
- https://developers.telnyx.com/api-reference/call-commands/reject-a-call.md
- https://developers.telnyx.com/api-reference/callbacks/call-initiated (and .md, which contained no schema)
- https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/reject.md
- https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming
- https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-webhooks
- https://developers.telnyx.com/docs/voice/sip-trunking/features/external-transfers.md
- https://developers.telnyx.com/docs/voice/webrtc/push-notifications/react-native.md
- https://developers.telnyx.com/docs/development/webrtc/react-native-sdk/push-notifications
- https://support.telnyx.com/en/articles/16666680-custom-sip-x-header-propagation-on-telnyx
- https://www.twilio.com/docs/sip-trunking
- https://www.twilio.com/docs/sip-trunking/call-transfer
- https://www.twilio.com/docs/sip-trunking/api/originationurl-resource
- https://www.twilio.com/docs/voice/twiml/reject
- https://www.twilio.com/docs/voice/twiml (and twiml.md)
- https://www.twilio.com/docs/voice/api/receiving-sip
- https://www.twilio.com/docs/voice/api/sip-interface
- https://www.twilio.com/docs/voice/bring-your-own-carrier-byoc
- https://www.twilio.com/en-us/voice/pricing/gb
- https://www.twilio.com/en-us/sip-trunking/pricing/gb
- Attempted but blocked (403): support.twilio.com articles 223180608 (SDK pricing) and 223132367 (call-forwarding charges)
