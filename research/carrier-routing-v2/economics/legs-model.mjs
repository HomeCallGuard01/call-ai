// Home Call Guard — leg-based trusted/unknown call cost model (carrier routing lab v2).
//
// Research only. Not imported by server.js or any product code.
//
// The model compares architectures by the CHARGEABLE LEGS each call creates and
// how long each leg is billed. It does not forecast customer behaviour: minutes
// and call counts are inputs. Rates are data (RATES below, or a JSON override
// file), so a carrier quote can be inserted later without touching the logic.
//
// A rate of `null` means "no published or measured figure: QUOTE required".
// Results that depend on a null rate are reported as a lower bound plus the list
// of missing rates; they are never silently treated as zero.
//
// Run:  node research/carrier-routing-v2/economics/legs-model.mjs
//       node research/carrier-routing-v2/economics/legs-model.mjs --rates my-quotes.json
//       node research/carrier-routing-v2/economics/legs-model.mjs --minutes 100,200,400 --subs 10000
//       node research/carrier-routing-v2/economics/legs-model.mjs --json

import { readFileSync } from "node:fs";

export const GBP_PER_USD = 0.75; // planning rate only (same as research/telephony/economics/model.mjs)

// status: MEASURED (HCG's own invoices) | LIST (provider's public price page) |
//         PUBLISHED_RETAIL | DERIVED | ASSUMPTION | QUOTE (unknown, gbp null)
export const RATES = {
  twilioInboundPerMin: { gbp: 0.00756, unit: "per started minute", status: "MEASURED", source: "Twilio invoice, trusted call CA43b447… 2026-09-12 (4 × £0.00756 for 239 s)" },
  twilioClientLegPerMin: { gbp: 0, unit: "per minute", status: "MEASURED", source: "Twilio invoice: <Dial><Client> child leg price null/£0 (list $0.004 — may change)" },
  twilioClientLegListPerMin: { gbp: 0.004 * GBP_PER_USD, unit: "per minute", status: "LIST", source: "twilio.com/en-us/voice/pricing/gb Voice SDK $0.004" },
  twilioStreamPerMin: { gbp: 0.00333, unit: "per monitored minute", status: "MEASURED", source: "Twilio usage records 2026-09-19" },
  twilioByocPerMin: { gbp: 0.004 * GBP_PER_USD, unit: "per minute", status: "LIST", source: "Twilio UK pricing BYOC $0.004" },
  twilioOutboundUkMobilePerMin: { gbp: 0.0305 * GBP_PER_USD, unit: "per minute", status: "LIST", source: "Twilio UK pricing outbound mobile $0.0305" },
  twilioRejectFirstVerb: { gbp: 0, unit: "per call", status: "LIST", source: "Twilio <Reject> docs: rejected-before-answer calls are not billed (POC 1 confirms on a forwarded call)" },
  twilioNumberMonthly: { gbp: 0.869, unit: "per number per month", status: "MEASURED", source: "Twilio pricing API on HCG account 2026-09-26 (public list $3.50)" },
  aiPerMonitoredMin: { gbp: 0.0078, unit: "per monitored minute", status: "DERIVED", source: "£0.0187 measured monitored minute − inbound − stream (post transcription fix 84e6159)" },
  sipInboundPerMin: { gbp: 0, unit: "per minute", status: "PUBLISHED_RETAIL", source: "Sipflex/sipgate retail free inbound (volume terms QUOTE)" },
  sipNumberMonthly: { gbp: 2.0, unit: "per number per month", status: "PUBLISHED_RETAIL", source: "Sipflex retail £2.00/number" },
  magratheaNumberMonthly: { gbp: 0.5, unit: "per number per month", status: "PUBLISHED_RETAIL", source: "Magrathea Annex 3 v6.0 (undated, linked from live client page): £0.50/number/month, free inbound, 10 channels/number, £100/month minimum" },
  ownRangeNumberMonthly: { gbp: null, unit: "per number per month", status: "QUOTE", source: "Own Ofcom range hosted by Magrathea or similar — hosting fee unpublished" },
  telnyxUkOriginationPerMin: { gbp: 0.005 * GBP_PER_USD, unit: "per minute", status: "LIST", source: "telnyx.com/pricing.md GB inbound to Local/National number $0.005 (UK mobile number $0.0032), fetched 2026-10-03" },
  telnyxVoiceApiPerMin: { gbp: 0.002 * GBP_PER_USD, unit: "per minute", status: "LIST", source: "telnyx.com/pricing/voice-api $0.002" },
  telnyxWebrtcPerMin: { gbp: 0.002 * GBP_PER_USD, unit: "per minute", status: "LIST", source: "telnyx.com pricing browser/app calling $0.002" },
  telnyxStreamPerMin: { gbp: 0.0035 * GBP_PER_USD, unit: "per monitored minute", status: "LIST", source: "Telnyx media streaming $0.0035 (prior research)" },
  telnyxChannelMonthly: { gbp: 15 * GBP_PER_USD, unit: "per channel per month", status: "LIST", source: "telnyx.com/pricing.md channel billing Zone A (UK) $15 at 0–10 channels → $10 at 250+; replaces inbound per-minute only (INFERRED); overflow = 'User Busy'" },
  hcgMediaPerMin: { gbp: 0.0002, unit: "per minute per leg", status: "ASSUMPTION", source: "Bandwidth + CPU of self-hosted media (~100 kbit/s per leg)" },
  fmcAnchoredLegPerMin: { gbp: null, unit: "per minute", status: "QUOTE", source: "FMC/MVNO provider bridging trusted call through its platform" },
  carrierSipEgressPerMin: { gbp: null, unit: "per minute", status: "QUOTE", source: "MVNO/FMC/carrier SIP delivery of unknown calls to HCG" },
  perSimMonthly: { gbp: null, unit: "per SIM per month", status: "QUOTE", source: "MVNO/FMC wholesale SIM + airtime" },
  mnoHookPerSubMonthly: { gbp: null, unit: "per subscriber per month", status: "QUOTE", source: "MNO caller-based CDIV / IMS AS hook (not offered by any UK MNO today)" },
};

// A leg is billed for `basis`:
//   "call"  = the whole conversation (minutes of the call)
//   "none"  = carried but never billed (e.g. <Reject> before answer)
// `onlyMonitored` legs exist only on unknown calls.
// `rounding` = "started-minute" means per-call round-up (Twilio 60/60).
const L = (name, rate, extra = {}) => ({ name, rate, basis: "call", rounding: "none", ...extra });

// Each architecture lists the legs HCG pays for on ONE call of each kind.
// IDs follow the decision report (758eb0cc…): R0/A1 today, A2 Telnyx, A3 Android,
// A4 iPhone, A5 carrier-for-other-MNO, A6 Telnyx Mobile Voice, A7 full MVNO,
// A9 FMC SIM, A10 MNO hook, A11 SIP edge, A12 dial-back.
export const ARCHITECTURES = {
  A1_twilio_cfu: {
    label: "A1 Today: **21* → Twilio → <Dial><Client>",
    trustedEntersHcg: true,
    trusted: [L("Twilio inbound (whole call)", "twilioInboundPerMin", { rounding: "started-minute" }), L("Voice SDK client leg", "twilioClientLegPerMin")],
    unknown: [L("Twilio inbound", "twilioInboundPerMin", { rounding: "started-minute" }), L("Voice SDK client leg", "twilioClientLegPerMin"), L("Media Stream", "twilioStreamPerMin"), L("Transcription + AI", "aiPerMonitoredMin")],
    fixedPerSub: ["twilioNumberMonthly"],
  },
  A1_sdk_at_list: {
    label: "A1 if Twilio bills the SDK leg at list",
    trustedEntersHcg: true,
    trusted: [L("Twilio inbound (whole call)", "twilioInboundPerMin", { rounding: "started-minute" }), L("Voice SDK client leg (list)", "twilioClientLegListPerMin")],
    unknown: [L("Twilio inbound", "twilioInboundPerMin", { rounding: "started-minute" }), L("Voice SDK client leg (list)", "twilioClientLegListPerMin"), L("Media Stream", "twilioStreamPerMin"), L("Transcription + AI", "aiPerMonitoredMin")],
    fixedPerSub: ["twilioNumberMonthly"],
  },
  A2_telnyx_cfu: {
    label: "A2 Same flow on Telnyx (per-minute origination)",
    trustedEntersHcg: true,
    trusted: [L("Telnyx UK origination", "telnyxUkOriginationPerMin"), L("Voice API", "telnyxVoiceApiPerMin"), L("WebRTC app leg", "telnyxWebrtcPerMin")],
    unknown: [L("Telnyx UK origination", "telnyxUkOriginationPerMin"), L("Voice API", "telnyxVoiceApiPerMin"), L("WebRTC app leg", "telnyxWebrtcPerMin"), L("Media stream", "telnyxStreamPerMin"), L("Transcription + AI", "aiPerMonitoredMin")],
    fixedPerSub: [],
    note: "Per-minute origination modelled. Channel billing ($15→$10/channel/month) would replace origination per-minute with a per-channel fee; Voice API + WebRTC per-minute would remain unless the quote says otherwise.",
  },
  A11_sip_edge_cfu: {
    label: "A11 Free-inbound SIP → HCG edge → Twilio BYOC → <Client> (**21* kept)",
    trustedEntersHcg: true,
    trusted: [L("SIP carrier inbound", "sipInboundPerMin"), L("Twilio BYOC", "twilioByocPerMin"), L("Voice SDK client leg", "twilioClientLegPerMin")],
    unknown: [L("SIP carrier inbound", "sipInboundPerMin"), L("Twilio BYOC", "twilioByocPerMin"), L("Voice SDK client leg", "twilioClientLegPerMin"), L("Media Stream", "twilioStreamPerMin"), L("Transcription + AI", "aiPerMonitoredMin")],
    fixedPerSub: ["sipNumberMonthly"],
    note: "Moves the trusted leg from Twilio inbound to BYOC; does not remove it. SDK-leg billing on BYOC is unconfirmed.",
  },
  A11_own_media: {
    label: "A11 + HCG-owned media/VoIP delivery (no Twilio on trusted path)",
    trustedEntersHcg: true,
    trusted: [L("SIP carrier inbound", "sipInboundPerMin"), L("HCG media relay (in)", "hcgMediaPerMin"), L("HCG media relay (out to app)", "hcgMediaPerMin")],
    unknown: [L("SIP carrier inbound", "sipInboundPerMin"), L("Twilio BYOC", "twilioByocPerMin"), L("Voice SDK client leg", "twilioClientLegPerMin"), L("Media Stream", "twilioStreamPerMin"), L("Transcription + AI", "aiPerMonitoredMin")],
    fixedPerSub: ["sipNumberMonthly"],
    note: "Near-zero marginal trusted cost but HCG carries the media and the platform (fixed infra, dual VoIP stack in app). Not £0 and not native dialler.",
  },
  A3_A4_handset_cfb_app: {
    label: "A3/A4 Handset decides → CFB → Twilio → app (unknown only)",
    trustedEntersHcg: false,
    trusted: [],
    leakage: [L("Trusted caller reaching HCG only because customer is busy: <Reject>", "twilioRejectFirstVerb", { basis: "none" })],
    unknown: [L("Twilio inbound", "twilioInboundPerMin", { rounding: "started-minute" }), L("Voice SDK client leg", "twilioClientLegPerMin"), L("Media Stream", "twilioStreamPerMin"), L("Transcription + AI", "aiPerMonitoredMin")],
    fixedPerSub: ["twilioNumberMonthly"],
  },
  A3_A4_handset_cfb_byoc: {
    label: "A3/A4 Handset decides → CFB → free-inbound SIP → BYOC → app",
    trustedEntersHcg: false,
    trusted: [],
    unknown: [L("SIP carrier inbound", "sipInboundPerMin"), L("Twilio BYOC", "twilioByocPerMin"), L("Voice SDK client leg", "twilioClientLegPerMin"), L("Media Stream", "twilioStreamPerMin"), L("Transcription + AI", "aiPerMonitoredMin")],
    fixedPerSub: ["sipNumberMonthly"],
  },
  A12_handset_cfb_dialback: {
    label: "A12 Handset decides → CFB → Twilio → dial-back to native dialler",
    trustedEntersHcg: false,
    trusted: [],
    unknown: [L("Twilio inbound", "twilioInboundPerMin", { rounding: "started-minute" }), L("Twilio outbound to UK mobile", "twilioOutboundUkMobilePerMin", { rounding: "started-minute" }), L("Media Stream", "twilioStreamPerMin"), L("Transcription + AI", "aiPerMonitoredMin")],
    fixedPerSub: ["twilioNumberMonthly"],
  },
  A7_A9_core_signalling_only: {
    label: "A7/A9 Mobile core decides (MVNO/FMC), signalling-only for trusted",
    trustedEntersHcg: false,
    trusted: [],
    unknown: [L("Carrier SIP egress to HCG", "carrierSipEgressPerMin"), L("Twilio BYOC", "twilioByocPerMin"), L("Voice SDK client leg", "twilioClientLegPerMin"), L("Media Stream", "twilioStreamPerMin"), L("Transcription + AI", "aiPerMonitoredMin")],
    fixedPerSub: ["perSimMonthly"],
    note: "Customer airtime, porting and mobile-provider obligations are outside this per-minute model (see operations analysis).",
  },
  A9_core_media_anchored: {
    label: "A9 FMC SIM where the provider anchors trusted media",
    trustedEntersHcg: false,
    trusted: [L("Provider-anchored trusted leg", "fmcAnchoredLegPerMin")],
    unknown: [L("Carrier SIP egress to HCG", "carrierSipEgressPerMin"), L("Twilio BYOC", "twilioByocPerMin"), L("Voice SDK client leg", "twilioClientLegPerMin"), L("Media Stream", "twilioStreamPerMin"), L("Transcription + AI", "aiPerMonitoredMin")],
    fixedPerSub: ["perSimMonthly"],
  },
  A10_mno_hook: {
    label: "A10 Customer's own MNO applies caller-based diversion",
    trustedEntersHcg: false,
    trusted: [],
    unknown: [L("Twilio inbound (or SIP + BYOC)", "twilioInboundPerMin", { rounding: "started-minute" }), L("Voice SDK client leg", "twilioClientLegPerMin"), L("Media Stream", "twilioStreamPerMin"), L("Transcription + AI", "aiPerMonitoredMin")],
    fixedPerSub: ["twilioNumberMonthly", "mnoHookPerSubMonthly"],
  },
};

export function loadRates(overridePath) {
  const rates = structuredClone(RATES);
  if (!overridePath) return rates;
  const override = JSON.parse(readFileSync(overridePath, "utf8"));
  for (const [key, value] of Object.entries(override)) {
    if (!(key in rates)) throw new Error(`Unknown rate key in override: ${key}`);
    const gbp = typeof value === "object" && value !== null ? value.gbp : value;
    if (gbp !== null && (typeof gbp !== "number" || gbp < 0)) throw new Error(`Rate ${key} must be a non-negative number or null`);
    rates[key] = { ...rates[key], gbp, status: value?.status ?? "QUOTE_RECEIVED", source: value?.source ?? `override file ${overridePath}` };
  }
  return rates;
}

// Billed minutes for one leg given a call of `minutes` length.
function billedMinutes(leg, minutes) {
  if (leg.basis === "none") return 0;
  return leg.rounding === "started-minute" ? Math.ceil(minutes - 1e-9) : minutes;
}

// Cost of one call of `minutes` on `legs`. Returns {gbp, missing[], legs}.
export function callCost(legs, minutes, rates = RATES) {
  let gbp = 0;
  const missing = [];
  const detail = [];
  for (const leg of legs) {
    const r = rates[leg.rate];
    if (!r) throw new Error(`Unknown rate ${leg.rate}`);
    const billed = billedMinutes(leg, minutes);
    if (r.gbp === null) {
      if (leg.basis !== "none") missing.push(leg.rate);
      detail.push({ leg: leg.name, billedMinutes: billed, gbp: null });
      continue;
    }
    const legGbp = r.unit === "per call" ? r.gbp : billed * r.gbp;
    gbp += legGbp;
    detail.push({ leg: leg.name, billedMinutes: billed, gbp: legGbp });
  }
  return { gbp, missing: [...new Set(missing)], legs: detail };
}

// Per-architecture summary: chargeable legs and £/minute (per-second equivalent,
// no rounding) for trusted and unknown calls.
export function summarise(arch, rates = RATES) {
  const perMin = (legs) => callCost(legs.map((l) => ({ ...l, rounding: "none" })), 1, rates);
  const trusted = perMin(arch.trusted);
  const unknown = perMin(arch.unknown);
  const fixedMissing = arch.fixedPerSub.filter((k) => rates[k].gbp === null);
  const fixed = arch.fixedPerSub.reduce((s, k) => s + (rates[k].gbp ?? 0), 0);
  return {
    label: arch.label,
    trustedEntersHcg: arch.trustedEntersHcg,
    trustedChargeableLegs: arch.trusted.filter((l) => l.basis !== "none").length,
    trustedPerMin: trusted.gbp,
    trustedMissing: trusted.missing,
    unknownChargeableLegs: arch.unknown.filter((l) => l.basis !== "none").length,
    unknownPerMin: unknown.gbp,
    unknownMissing: unknown.missing,
    fixedPerSub: fixed,
    fixedMissing,
  };
}

// Trusted-minute cost for a population. `avgCallMin` (optional) applies
// per-call rounding on started-minute legs; omit it for the per-second
// figures the decision report used (100/200/400 min → £7.6k/£15.1k/£30.2k).
export function trustedMonthlyCost(arch, { minutesPerSub, subs, avgCallMin }, rates = RATES) {
  if (arch.trusted.length === 0) return { gbp: 0, missing: [] };
  if (!avgCallMin) {
    const c = callCost(arch.trusted.map((l) => ({ ...l, rounding: "none" })), minutesPerSub, rates);
    return { gbp: c.gbp * subs, missing: c.missing };
  }
  const calls = minutesPerSub / avgCallMin;
  const c = callCost(arch.trusted, avgCallMin, rates);
  return { gbp: c.gbp * calls * subs, missing: c.missing };
}

const fmt = (v, dp = 4) => (v === null || v === undefined ? "QUOTE" : `£${v.toFixed(dp)}`);
const money = (v) => `£${Math.round(v).toLocaleString("en-GB")}`;

export function render({ rates = RATES, minutesList = [100, 200, 400], subs = 10000, avgCallMin } = {}) {
  const out = [];
  out.push("## Chargeable legs and per-minute cost by architecture\n");
  out.push("| Architecture | Trusted call enters HCG | Trusted legs on HCG account | Trusted £/min | Unknown legs on HCG account | Unknown £/min | Fixed £/sub/month |");
  out.push("|---|---|---|---|---|---|---|");
  for (const arch of Object.values(ARCHITECTURES)) {
    const s = summarise(arch, rates);
    const t = s.trustedMissing.length ? `≥ ${fmt(s.trustedPerMin)} + QUOTE (${s.trustedMissing.join(", ")})` : fmt(s.trustedPerMin);
    const u = s.unknownMissing.length ? `≥ ${fmt(s.unknownPerMin)} + QUOTE (${s.unknownMissing.join(", ")})` : fmt(s.unknownPerMin);
    const f = s.fixedMissing.length ? `≥ ${fmt(s.fixedPerSub, 3)} + QUOTE (${s.fixedMissing.join(", ")})` : fmt(s.fixedPerSub, 3);
    out.push(`| ${s.label} | ${s.trustedEntersHcg ? "Yes" : "No"} | ${s.trustedChargeableLegs} | ${t} | ${s.unknownChargeableLegs} | ${u} | ${f} |`);
  }
  out.push("");
  out.push(`## Trusted-minute cost at ${subs.toLocaleString("en-GB")} subscribers (ILLUSTRATION — minutes are inputs, not an HCG forecast)\n`);
  out.push(`Rounding: ${avgCallMin ? `per-call started-minute rounding with an assumed average call of ${avgCallMin} min` : "none (per-second equivalent, as in the decision report)"}.\n`);
  out.push(`| Architecture | ${minutesList.map((m) => `${m} trusted min/sub`).join(" | ")} |`);
  out.push(`|---|${minutesList.map(() => "---").join("|")}|`);
  for (const arch of Object.values(ARCHITECTURES)) {
    const cells = minutesList.map((m) => {
      const r = trustedMonthlyCost(arch, { minutesPerSub: m, subs, avgCallMin }, rates);
      return r.missing.length ? `≥ ${money(r.gbp)} + QUOTE` : money(r.gbp);
    });
    out.push(`| ${arch.label} | ${cells.join(" | ")} |`);
  }
  out.push("");
  out.push("## Rates used\n");
  out.push("| Key | £ | Unit | Status | Source |");
  out.push("|---|---|---|---|---|");
  for (const [k, r] of Object.entries(rates)) out.push(`| ${k} | ${r.gbp === null ? "null" : r.gbp.toFixed(5)} | ${r.unit} | ${r.status} | ${r.source} |`);
  return out.join("\n");
}

function parseArgs(argv) {
  const args = { minutesList: [100, 200, 400], subs: 10000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--rates") args.ratesPath = argv[++i];
    else if (a === "--minutes") args.minutesList = argv[++i].split(",").map(Number);
    else if (a === "--subs") args.subs = Number(argv[++i]);
    else if (a === "--avg-call-min") args.avgCallMin = Number(argv[++i]);
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const rates = loadRates(args.ratesPath);
  if (args.json) {
    const result = Object.fromEntries(Object.entries(ARCHITECTURES).map(([id, a]) => [id, summarise(a, rates)]));
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(render({ rates, minutesList: args.minutesList, subs: args.subs, avgCallMin: args.avgCallMin }));
  }
}
