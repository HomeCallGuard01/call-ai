// Provider response pack: the question bank and what each answer means.
//
// Each question has rules per answer (YES / NO / PARTIAL / UNCLEAR). A rule says:
//   capability  — what is confirmed or ruled out, in one line
//   affects     — architecture IDs from the decision report (A1…A12, C1–C3)
//   poc1        — effect on POC 1: "REMOVES" | "REMOVES_FOR_NETWORK" | "OPTIONAL_IF_SIM_SWITCH_ACCEPTED"
//                 | "NARROWS" | "NONE"
//   followUp    — the next question to send (drafted only; Andrew sends it, never Claude)
// UNANSWERED and UNCLEAR fall back to the question's `askAgain` text.
//
// `commercial` lists the numbers still needed from that provider before any
// economic comparison; the classifier reports which are still blank.

const NONE = "NONE";

export const PROVIDERS = {
  AQL: {
    name: "aql (and BlueWave core)",
    note: "Already contacted by Andrew. Do not send a second unsolicited email; use these only to classify the reply and to prepare follow-ups for Andrew.",
    commercial: ["setupFee", "perSimMonthly", "perDivertedMinute", "sipEgressPerMinute", "minimumVolume1k", "minimumVolume10k", "trialSimsAvailable", "freeInboundDidMonthly"],
    questions: {
      "AQL-1": {
        q: "Do programmable diversion / number-level routing / mobile-core routing apply to calls to a number that STAYS on EE, O2, Vodafone or Three, before that network delivers or forwards them?",
        YES: { capability: "Caller-based routing for subscribers who keep their SIM and network", affects: ["A5", "A10"], poc1: "REMOVES", followUp: "Which networks, by what interconnect mechanism (IMS AS / CDIV / CAMEL), and can you show a test call on one of our SIMs without moving it?" },
        NO: { capability: "aql routing applies only to aql-hosted numbers/SIMs (expected)", affects: ["A5"], poc1: NONE, followUp: "Confirm the per-call hook exists for aql/BlueWave SIMs (AQL-2)." },
        PARTIAL: { capability: "Applies on some networks or only under conditions", affects: ["A5", "A10"], poc1: "NARROWS", followUp: "Which networks and which conditions exactly? Does the customer's network still have to forward the call to aql first (in which case it is A5, not caller-based routing)?" },
        askAgain: "For each capability you mentioned, does it apply to (a) aql/BlueWave SIMs, (b) numbers hosted on aql's switch, or (c) subscribers of another UK MNO?",
      },
      "AQL-2": {
        q: "For aql/BlueWave SIMs, can the core make a per-call decision before the handset rings (IMS AS via iFC, SIP 3xx, HTTP/ENUM lookup to HCG)?",
        YES: { capability: "Per-call pre-ring hook in a mobile core", affects: ["A7", "C1"], poc1: "OPTIONAL_IF_SIM_SWITCH_ACCEPTED", followUp: "What latency budget, and what is the default if HCG does not answer (must be: deliver normally)?" },
        NO: { capability: "No per-call hook: A7 via aql closed", affects: ["A7", "C1"], poc1: NONE, followUp: "Could aql host the trusted list itself (500+ entries/subscriber, ≤60 s updates) and apply 'divert unless trusted'?" },
        PARTIAL: { capability: "Hook exists with limits (e.g. list-based only, or business SIMs only)", affects: ["A7", "C1"], poc1: NONE, followUp: "Which limits, and do they apply to consumer SIMs?" },
        askAgain: "Can your core run a per-call terminating decision before the SIM rings, and in what form?",
      },
      "AQL-3": {
        q: "On 'deliver', is the trusted call delivered natively with no media through HCG or aql's platform and no per-minute charge to HCG?",
        YES: { capability: "Trusted calls £0/min to HCG on aql SIMs", affects: ["A7", "C1"], poc1: "OPTIONAL_IF_SIM_SWITCH_ACCEPTED", followUp: "Please confirm in writing which CDR fields would show zero HCG charge for a delivered trusted call." },
        NO: { capability: "Trusted media anchored or charged: A7 becomes a per-minute leg (A9-anchored shape)", affects: ["A7", "A9"], poc1: NONE, followUp: "What is the per-minute charge for an anchored trusted leg?" },
        PARTIAL: { capability: "Signalling-only but some per-call or per-minute fee remains", affects: ["A7"], poc1: NONE, followUp: "What exactly is charged, per call or per minute, for a delivered trusted call?" },
        askAgain: "For a trusted caller, who carries the media and who pays per minute?",
      },
      "AQL-4": {
        q: "Can consumers port an existing EE/O2/Vodafone/Three 07 number to an aql SIM (PAC / text-to-switch)?",
        YES: { capability: "Customer keeps their number on an aql SIM", affects: ["A7", "C1"], poc1: NONE, followUp: "Typical port lead time and failure rate; can we test-port one spare number?" },
        NO: { capability: "A7 via aql fails 'keep your number'", affects: ["A7", "C1"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "Port-in possible with conditions", affects: ["A7"], poc1: NONE, followUp: "Which conditions (business only, postpaid only, specific ranges)?" },
        askAgain: "Do you hold 07 ranges and take part in UK mobile number porting for consumers?",
      },
      "AQL-5": {
        q: "Do aql SIMs support VoLTE and Wi-Fi Calling on iPhone and Android (Apple carrier settings for your PLMN)?",
        YES: { capability: "iPhone works natively on aql SIMs", affects: ["A7", "C1"], poc1: NONE, followUp: "Which iOS carrier bundle name/version, and is it listed on support.apple.com/en-gb/108048?" },
        NO: { capability: "A7 via aql fails on iPhone (2G fallback only after 3G switch-off)", affects: ["A7", "C1"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "Android only, or VoLTE without Wi-Fi Calling", affects: ["A7"], poc1: NONE, followUp: "Roadmap and date for iPhone carrier settings?" },
        askAgain: "Is there an Apple carrier settings bundle for your network?",
      },
      "AQL-6": {
        q: "Will aql supply SIMs for HCG to retail to consumers under HCG's brand, with default bars (premium, international, roaming) and per-SIM credit limits?",
        YES: { capability: "Consumer retail permitted with controls", affects: ["A7"], poc1: NONE, followUp: "Who carries fraud liability, and can bars be locked against API change?" },
        NO: { capability: "A7 via aql is business-only", affects: ["A7"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "Consumer allowed without the requested controls, or white-label only", affects: ["A7"], poc1: NONE, followUp: "Which controls are missing?" },
        askAgain: "Is consumer resale under our brand allowed, and with what airtime controls?",
      },
      "AQL-7": {
        q: "On Three (aql's radio host), does a SIP 486 or 603 from a declining VoLTE handset trigger Call Forwarding on Busy?",
        YES: { capability: "Network half of POC 1 predicted for Three", affects: ["A3", "A4"], poc1: "NARROWS", followUp: "Does the same apply on VoWiFi and 2G (UDUB)?" },
        NO: { capability: "Three would not forward a handset decline: A3/A4 fail on Three", affects: ["A3", "A4"], poc1: "NARROWS", followUp: "What does Three do with a 486/603 instead (voicemail, busy tone)?" },
        PARTIAL: { capability: "Only 486 or only one radio path", affects: ["A3", "A4"], poc1: "NARROWS", followUp: "Which code and which radio path?" },
        askAgain: "What does the network do with a handset decline when CFB is set?",
      },
      "AQL-8": {
        q: "Free-inbound SIP DIDs for forwarded unknown calls, with per-DID channel caps and maximum call duration (C3)?",
        YES: { capability: "Cheap ingress for the unknown path", affects: ["C3", "A11", "A3", "A4"], poc1: NONE, followUp: "Do you pass PAI / History-Info / Diversion from UK mobile diverts unchanged?" },
        NO: { capability: "No change to ingress cost", affects: ["C3"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "Ingress available without the caps", affects: ["C3"], poc1: NONE, followUp: "Can caps be set by you, not by our software?" },
        askAgain: "Inbound pricing and per-DID controls for numbers hosted on aql's switch?",
      },
    },
  },

  MAGRATHEA: {
    name: "Magrathea",
    note: "Not contacted. Questions are drafts.",
    commercial: ["hostingFeePerNumberMonthly", "ownRangeSetupFee", "inboundPerMinute", "channelFeeMonthly", "minimumMonthlySpend", "portInFeePerNumber"],
    questions: {
      "MAG-1": {
        q: "Will you host an HCG-owned Ofcom geographic range (block of 1,000), managed by API, with free inbound to our SIP endpoint?",
        YES: { capability: "Per-household forwarding numbers at pennies; HCG controls routing of its own numbers", affects: ["G2", "A11", "A3", "A4"], poc1: NONE, followUp: "Lead time from Ofcom allocation to live routing, and hosting fee per number." },
        NO: { capability: "Own-range route via Magrathea closed", affects: ["G2"], poc1: NONE, followUp: "Do you rent wholesale DIDs from your own ranges instead, and at what price at 1k/10k?" },
        PARTIAL: { capability: "Hosting available with minimums or without API", affects: ["G2"], poc1: NONE, followUp: "What minimums?" },
        askAgain: "Do you host operator-owned ranges for a new communications provider, and how is routing managed?",
      },
      "MAG-2": {
        q: "Your price list shows 10 concurrent channels per number and free inbound: can the per-number cap be set lower (e.g. 2), is a maximum call duration enforceable on your side, and at what volume does free inbound end?",
        YES: { capability: "External per-household cost bound at ingress", affects: ["G2", "A11", "A3", "A4"], poc1: NONE, followUp: "Can those caps be changed only by your support desk (not by our API key)?" },
        NO: { capability: "Bounds must come from elsewhere", affects: ["G2"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "Trunk-level caps only", affects: ["G2"], poc1: NONE, followUp: "Smallest granularity of channel caps?" },
        askAgain: "What concurrency and duration limits can you enforce per number?",
      },
      "MAG-3": {
        q: "In Network Mode, do diverts from EE, O2, Vodafone and Three actually arrive with the original CLI plus the last diverted line identity (Diversion / LDLI)? Sample INVITE?",
        YES: { capability: "Household can be identified from signalling (shared numbers possible)", affects: ["G3", "A11"], poc1: NONE, followUp: "Is that true for diverts from all four MNOs, and from MVNOs on them?" },
        NO: { capability: "Shared numbers impossible via Magrathea", affects: ["G3"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "Only some networks pass it", affects: ["G3"], poc1: NONE, followUp: "Which networks?" },
        askAgain: "Which SIP headers reach us on a mobile-diverted call?",
      },
      "MAG-4": {
        q: "Can your platform ask our endpoint for a routing decision BEFORE answering and, on 'deliver to PSTN number X', leave the media path (no further leg billed to us)?",
        YES: { capability: "Pre-answer redirect with release. Useful only where the destination does not forward back to us (never under **21*)", affects: ["A11", "G1"], poc1: NONE, followUp: "Who is billed for the onward PSTN leg after release, and does the original caller's CLI survive?" },
        NO: { capability: "Magrathea stays in path for any onward call (as every CPaaS found)", affects: ["A11"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "Redirect possible but the onward leg is billed to the number holder", affects: ["A11", "G1"], poc1: NONE, followUp: "Per-minute rate of the onward leg?" },
        askAgain: "What happens, and who pays, when we answer an inbound INVITE with a 302 to a UK mobile number?",
      },
      "MAG-5": {
        q: "Your August 2026 newsletter mentions a mobile product in testing: what is it, when does it launch, and can you port in or host 07 mobile numbers (on SIM or VoIP)?",
        YES: { capability: "Number-hosting route: customer ports 07 to HCG host, HCG routes trusted calls onward (but the handset loses its native number)", affects: ["N1"], poc1: NONE, followUp: "How are onward calls to the customer's (new) SIM number billed?" },
        NO: { capability: "No 07 hosting", affects: ["N1"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "07 hosting with restrictions", affects: ["N1"], poc1: NONE, followUp: "Which restrictions?" },
        askAgain: "Do you take port-ins of 07 mobile numbers?",
      },
      "MAG-6": {
        q: "Can outbound calling be barred on our account (or limited to UK geographic/mobile) by you, independent of our API credentials?",
        YES: { capability: "Provider-enforced outbound containment", affects: ["G2", "A12"], poc1: NONE, followUp: NONE },
        NO: { capability: "Outbound containment must be built elsewhere", affects: ["A12"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "Barring exists but is changeable by API", affects: ["A12"], poc1: NONE, followUp: "Can API changes to barring be disabled?" },
        askAgain: "What outbound barring do you enforce?",
      },
    },
  },

  TELNYX: {
    name: "Telnyx",
    note: "A meeting took place on 30 Sep 2026 but no written notes of what Telnyx said exist in the repository. Record the meeting's answers here, then confirm them in writing.",
    commercial: ["ukOriginationPerMinute", "billingIncrement", "channelPriceMonthly", "channelMinimum", "voiceApiPerMinute", "webrtcPerMinute", "streamingPerMinute", "ukNumberMonthly", "mobileVoicePerSimMonthly", "mobileVoiceIncomingPerMinute"],
    questions: {
      "TEL-1": {
        q: "Is channel billing available for UK (GB) numbers used with Call Control and WebRTC, and which per-minute fees (origination, Voice API, WebRTC, streaming) does it replace?",
        YES: { capability: "Trusted minutes become a flat per-channel cost (cheaper, still a leg)", affects: ["A2"], poc1: NONE, followUp: "What happens to calls above the channel count (rejected = delivery stops, which breaks the forwarding requirement)?" },
        NO: { capability: "Telnyx is per-minute like Twilio; only the rate differs", affects: ["A2"], poc1: NONE, followUp: "UK origination per-minute rate and increment?" },
        PARTIAL: { capability: "Channel billing covers origination only; Voice API/WebRTC per-minute remain", affects: ["A2"], poc1: NONE, followUp: "Confirm the residual per-minute fees in writing." },
        askAgain: "Which fees does channel billing replace for UK inbound with Call Control + WebRTC?",
      },
      "TEL-2": {
        q: "Is there any Call Control action after which Telnyx leaves both signalling and media of a PSTN-originated inbound call, with no further charge (e.g. refer)?",
        YES: { capability: "Release exists, but under **21* the only PSTN destination forwards back (loop); under CFB trusted calls never arrive. So no trusted-cost effect", affects: ["A2"], poc1: NONE, followUp: "Which UK interconnects accept it, and is the onward leg billed to anyone?" },
        NO: { capability: "Telnyx stays pivot (matches prior doc findings)", affects: ["A2"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "Release only for SIP-originated calls", affects: ["A2"], poc1: NONE, followUp: NONE },
        askAgain: "After transfer/refer on a PSTN-originated UK call, which legs remain and who pays?",
      },
      "TEL-3": {
        q: "Can Telnyx Mobile Voice SIMs/eSIMs hold UK 07 numbers, including numbers ported from EE/O2/Vodafone/Three?",
        YES: { capability: "Self-serve SIM route keeps the customer's number", affects: ["A6"], poc1: NONE, followUp: "Which UK host network and does it serve consumers?" },
        NO: { capability: "A6 fails 'keep your number' in the UK", affects: ["A6"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "New UK numbers only, no port-in", affects: ["A6"], poc1: NONE, followUp: "Port-in roadmap?" },
        askAgain: "UK 07 numbers and porting on Mobile Voice?",
      },
      "TEL-4": {
        q: "Does a Mobile Voice connection (e.g. the `inbound.interception_app_id` field in your MobilePhoneNumber API) call HCG BEFORE the SIM rings, letting HCG choose 'ring natively' or 'route to Call Control', with a fail-open default?",
        YES: { capability: "Per-call pre-ring hook on a programmable SIM", affects: ["A6"], poc1: "OPTIONAL_IF_SIM_SWITCH_ACCEPTED", followUp: "Is a natively-delivered trusted call billed per minute to us?" },
        NO: { capability: "Mobile Voice cannot split trusted/unknown per call", affects: ["A6"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "Static rules only (no per-call webhook)", affects: ["A6"], poc1: NONE, followUp: "Can the rule be an allow-list per SIM managed by API?" },
        askAgain: "What per-call control exists before a Mobile Voice SIM rings?",
      },
      "TEL-5": {
        q: "Is a natively-delivered incoming call to a Mobile Voice SIM free of per-minute charges to HCG, and do VoLTE and Wi-Fi Calling work on iPhone in the UK?",
        YES: { capability: "A6 trusted calls £0/min and iPhone native", affects: ["A6"], poc1: "OPTIONAL_IF_SIM_SWITCH_ACCEPTED", followUp: "UK GA date and consumer eligibility?" },
        NO: { capability: "A6 trusted calls billed per minute, or iPhone unsupported", affects: ["A6"], poc1: NONE, followUp: "Which of the two, and the incoming rate?" },
        PARTIAL: { capability: "One of the two holds", affects: ["A6"], poc1: NONE, followUp: "Which part is missing?" },
        askAgain: "Incoming billing and iPhone VoLTE on Mobile Voice?",
      },
      "TEL-6": {
        q: "Does the Telnyx React Native SDK support iOS PushKit/CallKit and Android FCM incoming calls equivalent to Twilio <Dial><Client>?",
        YES: { capability: "App delivery portable to Telnyx (A2)", affects: ["A2"], poc1: NONE, followUp: "Can both Twilio and Telnyx SDKs coexist in one app during migration?" },
        NO: { capability: "A2 needs a native app rewrite", affects: ["A2"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "One platform only", affects: ["A2"], poc1: NONE, followUp: "Which?" },
        askAgain: "Push-driven incoming calls in the RN SDK?",
      },
    },
  },

  TWILIO: {
    name: "Twilio (Finnian)",
    note: "Twilio said 'decide upstream on the carrier/SIP side'. Classify what they actually mean.",
    commercial: ["committedInboundPerMinute1k", "committedInboundPerMinute10k", "byocPerMinute", "sdkLegOnByocPerMinute", "streamsPerMinuteCommitted"],
    questions: {
      "TWI-1": {
        q: "Which product or carrier arrangement acts BEFORE the customer's own MNO delivers or forwards the call?",
        YES: { capability: "Named upstream arrangement for consumer numbers on other MNOs", affects: ["A10", "A5"], poc1: "REMOVES", followUp: "Which carrier, which networks, and can it be trialled on one of our SIMs?" },
        NO: { capability: "'Upstream' = BYOC/SIP trunking (U3) or the handset (U1): no trusted-cost effect by itself", affects: ["A11"], poc1: NONE, followUp: "Confirm SDK-leg billing on BYOC calls (TWI-4)." },
        PARTIAL: { capability: "Arrangement exists only for numbers Twilio's partner hosts", affects: ["A7", "A11"], poc1: NONE, followUp: "Who hosts the number and does the customer keep their SIM?" },
        askAgain: "Please sketch the call flow you meant for a UK consumer mobile number.",
      },
      "TWI-2": {
        q: "Is <Reject> as the first verb unbilled on calls that arrive by mobile-network conditional forwarding (CFB/CFNRy)?",
        YES: { capability: "Trusted callers who reach HCG only because the customer is busy cost £0", affects: ["A3", "A4", "A12"], poc1: NONE, followUp: NONE },
        NO: { capability: "Leakage under CFB/CFNRy has a cost per call", affects: ["A3", "A4", "A12"], poc1: NONE, followUp: "What is charged?" },
        PARTIAL: { capability: "Unbilled with conditions", affects: ["A3", "A4"], poc1: NONE, followUp: "Which conditions?" },
        askAgain: "Billing of <Reject> on forwarded calls?",
      },
      "TWI-3": {
        q: "Is ForwardedFrom (or any field) populated with the diverting subscriber number on CFB/CFNRy calls?",
        YES: { capability: "Household identifiable from the call (shared numbers possible on Twilio)", affects: ["G3"], poc1: NONE, followUp: NONE },
        NO: { capability: "Matches 184/184 production calls: one number per household on Twilio", affects: ["G3"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "Only via SIP/BYOC headers", affects: ["G3", "A11"], poc1: NONE, followUp: "Which header names reach the webhook?" },
        askAgain: "Diverting identity on forwarded calls?",
      },
      "TWI-4": {
        q: "On BYOC-originated calls, is the Voice SDK <Client> leg billed, and at what rate? Is the £0 on our invoices permanent?",
        YES: { capability: "SDK leg billed: A11 and every app-delivery route cost more per minute", affects: ["A11", "A1", "A3", "A4"], poc1: NONE, followUp: "Rate and effective date?" },
        NO: { capability: "SDK leg £0: A11 trusted cost = BYOC only", affects: ["A11"], poc1: NONE, followUp: "Please confirm in writing." },
        PARTIAL: { capability: "Promotional or volume-dependent", affects: ["A11", "A1"], poc1: NONE, followUp: "Until when?" },
        askAgain: "SDK leg billing on PSTN- and BYOC-originated calls?",
      },
      "TWI-5": {
        q: "Can outbound voice/SMS geo permissions be locked against API change; per-number concurrency caps; hard spend stop on a subaccount?",
        YES: { capability: "Provider-enforced containment available", affects: ["A1", "A3", "A4", "A12"], poc1: NONE, followUp: NONE },
        NO: { capability: "Containment must move to another provider or prepaid design", affects: ["A1", "A12"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "Some controls", affects: ["A1", "A12"], poc1: NONE, followUp: "Which are missing?" },
        askAgain: "Which of these hard limits can Twilio enforce?",
      },
      "TWI-6": {
        q: "For a dial-back of a screened call to the customer's mobile, may the caller ID be the original caller's number, or only an owned/verified number?",
        YES: { capability: "Dial-back can show the real caller", affects: ["A12"], poc1: NONE, followUp: NONE },
        NO: { capability: "Dial-back shows HCG's number (customer must recognise it)", affects: ["A12"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "Allowed only in some configurations", affects: ["A12"], poc1: NONE, followUp: "Which?" },
        askAgain: "Caller-ID rules for a dial-back leg?",
      },
    },
  },

  // One block per UK network group; answers apply to that network's own subscribers.
  EE: networkBlock("BT/EE"),
  VMO2: networkBlock("Virgin Media O2"),
  VODAFONETHREE: networkBlock("VodafoneThree"),

  FMC: {
    name: "FMC / MVNO providers (iQ Mobile, Gamma, Wireless Logic/Cloud9)",
    note: "Wireless Logic contacted by Andrew (30 Sep); iQ Mobile and Gamma not contacted. Use one copy per provider if replies differ.",
    commercial: ["perSimMonthly", "airtimeWholesale", "sipEgressPerMinute", "anchoredLegPerMinute", "minimumVolume1k", "minimumVolume10k", "trialSims"],
    questions: {
      "FMC-1": {
        q: "Can an inbound call to your SIM be decided per call by a partner SIP endpoint answering 'deliver natively' (redirect) WITHOUT the media passing through your platform or ours?",
        YES: { capability: "Signalling-only per-call hook on a SIM route", affects: ["A9", "A7"], poc1: "OPTIONAL_IF_SIM_SWITCH_ACCEPTED", followUp: "Default if our endpoint is down (must be deliver)?" },
        NO: { capability: "Provider anchors media: trusted calls carry a wholesale leg", affects: ["A9"], poc1: NONE, followUp: "Per-minute price of the anchored leg?" },
        PARTIAL: { capability: "Hook exists but media is anchored", affects: ["A9"], poc1: NONE, followUp: "Per-minute price of the anchored leg?" },
        askAgain: "Who carries the media for a call your partner endpoint says to deliver?",
      },
      "FMC-2": {
        q: "Is consumer resale allowed?",
        YES: { capability: "Consumer FMC product possible", affects: ["A9", "A7"], poc1: NONE, followUp: NONE },
        NO: { capability: "Business-only: closed for HCG consumers", affects: ["A9", "A7"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "Consumer allowed with conditions", affects: ["A9"], poc1: NONE, followUp: "Which conditions?" },
        askAgain: "Consumer resale permitted?",
      },
      "FMC-3": {
        q: "Apple carrier settings (VoLTE, Wi-Fi Calling) for your network?",
        YES: { capability: "iPhone works natively", affects: ["A9", "A7"], poc1: NONE, followUp: NONE },
        NO: { capability: "Fails on iPhone", affects: ["A9", "A7"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "VoLTE only or roadmap", affects: ["A9"], poc1: NONE, followUp: "Date?" },
        askAgain: "iPhone carrier settings?",
      },
      "FMC-4": {
        q: "Port-in of consumer 07 numbers?",
        YES: { capability: "Customer keeps number", affects: ["A9", "A7"], poc1: NONE, followUp: NONE },
        NO: { capability: "Fails 'keep your number'", affects: ["A9", "A7"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "Business port-ins only", affects: ["A9"], poc1: NONE, followUp: NONE },
        askAgain: "Consumer 07 port-in?",
      },
    },
  },
};

function networkBlock(name) {
  return {
    name,
    note: "Andrew contacted BT/EE and Vodafone's network-API team on 30 Sep. VMO2 not contacted. All three sell competing scam-call products.",
    commercial: ["perSubscriberMonthly", "setupFee", "minimumVolume", "trialAvailability"],
    questions: {
      "MNO-1": {
        q: "Will you offer caller-based conditional diversion (CDIV with cp:identity) or an IMS terminating AS hook for opted-in subscribers via a partner API?",
        YES: { capability: `Network-side split for ${name} subscribers, no SIM change`, affects: ["A10"], poc1: "REMOVES_FOR_NETWORK", followUp: "VoLTE, VoWiFi and CS coverage? Fail-open default? Trusted-list size and update latency?" },
        NO: { capability: `No network hook on ${name}`, affects: ["A10"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "Roadmap or business-only", affects: ["A10"], poc1: NONE, followUp: "Date, and is consumer opt-in planned?" },
        askAgain: "Is any caller-based diversion or terminating hook available to partners?",
      },
      "MNO-2": {
        q: "With CFB set, does a handset decline (SIP 486 or 603 over VoLTE/VoWiFi; UDUB on 2G) trigger Call Forwarding on Busy?",
        YES: { capability: `Network half of POC 1 predicted for ${name}`, affects: ["A3", "A4"], poc1: "NARROWS", followUp: "Does 603 behave the same as 486?" },
        NO: { capability: `A3/A4 fail on ${name}`, affects: ["A3", "A4"], poc1: "NARROWS", followUp: "Where does a declined call go instead?" },
        PARTIAL: { capability: "Depends on code or radio path", affects: ["A3", "A4"], poc1: "NARROWS", followUp: "Which?" },
        askAgain: "What does the network do with a handset decline when CFB is active?",
      },
      "MNO-3": {
        q: "On a CFB/CFU divert, is the original caller's CLI presented to the divert target, plus the diverting line identity (ND1016)?",
        YES: { capability: "HCG sees the real caller (and household) on diverted calls", affects: ["A3", "A4", "G3"], poc1: NONE, followUp: NONE },
        NO: { capability: "HCG cannot check trust on diverted calls from this network", affects: ["A3", "A4", "A1"], poc1: "NARROWS", followUp: "What CLI is presented?" },
        PARTIAL: { capability: "CLI yes, diverting identity no", affects: ["G3"], poc1: NONE, followUp: NONE },
        askAgain: "Which CLI reaches the divert target?",
      },
      "MNO-4": {
        q: "Is the Call Forwarding Signal (CAMARA) API or equivalent available to HCG to read a consenting subscriber's forwarding state?",
        YES: { capability: "HCG can verify forwarding set-up and offboard safely", affects: ["A3", "A4", "A1"], poc1: NONE, followUp: "Pricing and consent flow?" },
        NO: { capability: "Verification stays test-call based", affects: ["A3", "A4"], poc1: NONE, followUp: NONE },
        PARTIAL: { capability: "Via aggregator only", affects: ["A3", "A4"], poc1: NONE, followUp: "Which aggregator?" },
        askAgain: "Forwarding-status API availability?",
      },
    },
  };
}

export const NETWORK_KEYS = ["EE", "VMO2", "VODAFONETHREE"];
export const ANSWERS = ["YES", "NO", "PARTIAL", "UNCLEAR", "UNANSWERED"];

// A SIM-switch route counts as fully confirmed only when every listed question is YES.
export const SIM_ROUTE_BUNDLES = {
  "aql SIM (A7/C1)": { provider: "AQL", all: ["AQL-2", "AQL-3", "AQL-4", "AQL-5", "AQL-6"] },
  "FMC SIM (A9)": { provider: "FMC", all: ["FMC-1", "FMC-2", "FMC-3", "FMC-4"] },
  "Telnyx Mobile Voice (A6)": { provider: "TELNYX", all: ["TEL-3", "TEL-4", "TEL-5"] },
};
