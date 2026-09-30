// HCG four-architecture model: per-leg costs, portfolio economics (cost
// categories A–I) and CATASTROPHIC exposure. RESEARCH ONLY (2026-09-30/10-01).
// Portfolio economics answers "is the business profitable?".
// Catastrophic exposure answers "can the business survive failure/attack?".
// They are computed separately and must never be traded off.
// Run with: node research/viability/architecture-model.js > research/viability/ARCHITECTURE_MODEL_OUTPUT.md
'use strict';

const L = { INV: 'CONFIRMED HCG INVOICE', PUB: 'CURRENT OFFICIAL PUBLISHED PRICE', QUOTE: 'PROVIDER QUOTE REQUIRED', ASM: 'ASSUMPTION' };
const FX = { value: 0.79, label: L.ASM, note: 'USD→GBP (conservative)' };
const usd = (x) => x * FX.value;

// ── Per-leg price book ───────────────────────────────────────────────────
const P = {
  twNumberBilled:  { v: 0.86917, l: L.INV, s: 'Twilio billed number-months (45)' },
  twNumberList:    { v: usd(3.50), l: L.PUB, s: 'twilio.com/en-us/voice/pricing/gb: local number $3.50/mo' },
  twInboundBilled: { v: 0.007558, l: L.INV, s: 'Twilio billed, per started minute' },
  twInboundList:   { v: usd(0.0100), l: L.PUB, s: 'twilio.com/…/pricing/gb: inbound local $0.0100/min' },
  twSdkBilled:     { v: 0, l: L.INV, s: '£0 billed on every client leg to date' },
  twSdkList:       { v: usd(0.0040), l: L.PUB, s: 'twilio.com/…/pricing/gb: Voice SDK $0.0040/min' },
  twByoc:          { v: usd(0.0040), l: L.PUB, s: 'twilio.com/…/pricing/gb + changelog: BYOC trunking $0.0040/min each direction' },
  twSipIface:      { v: usd(0.0040), l: L.PUB, s: 'twilio.com/…/pricing/gb: SIP interface $0.0040/min — whether it ALSO applies to BYOC-originated calls: QUOTE' },
  twStreamBilled:  { v: 0.003329, l: L.INV, s: 'Twilio billed Media Streams' },
  twStreamList:    { v: usd(0.0044), l: L.PUB, s: 'twilio.com/…/pricing/gb: Media Streams $0.0044/min' },
  twPolly:         { v: 0.0006, l: L.INV, s: 'Twilio billed Polly greeting' },
  twSms:           { v: 0.042325, l: L.INV, s: 'Twilio Pricing API SMS segment' },
  sipNumber:       { v: 2.00, l: L.PUB, s: 'sipflex.co.uk £2/number/month (retail; wholesale QUOTE)' },
  sipInbound:      { v: 0, l: L.PUB, s: 'sipflex.co.uk / sipgatetrunking.co.uk: inbound free (at-volume terms QUOTE)' },
  sipChannel:      { v: 1.00, l: L.PUB, s: 'sipflex.co.uk £1 per extra concurrent channel/month' },
  transcription:   { v: usd(0.006), l: L.PUB, s: 'OpenAI whisper-1 $0.006/min' },
  selfInfraPer1k:  { v: 600, l: L.ASM, s: 'HCG-owned delivery: 2+ regions SBC/SIP proxy/media/TURN/monitoring, £/month per 1,000 subs (excl. staff)' },
  selfBandwidth:   { v: 0.00007, l: L.ASM, s: '~64 kbit/s each way ≈ 1 MB/min at ~£0.07/GB egress' },
  selfOpsStaff:    { v: 4000, l: L.ASM, s: 'On-call/ops share for a self-run telecom platform £/month (fixed, independent of subs)' },
  networkFee:      { v: null, l: L.QUOTE, s: 'MNO/MVNE selective-routing fee: not published' },
  fraudReserve:    { v: 0.10, l: L.ASM, s: 'H: fraud/abuse contingency £/sub/month (within hard containment only)' },
  storeFee:        { v: 0.15, l: L.PUB, s: 'Apple SBP / Google Play 15% of net (Apple SBP enrolment UNCONFIRMED)' },
  stripePct:       { v: 0.027, l: L.PUB, s: 'Stripe UK 1.5% + Billing 0.7% + Tax 0.5%' },
  stripeFixed:     { v: 0.20, l: L.PUB, s: 'Stripe UK 20p' },
  storeShare:      { v: 0.70, l: L.ASM, s: 'Share paying via stores' },
  vat:             { v: 0.20, l: L.PUB, s: 'UK VAT' },
};
const p = (k) => P[k].v;

// ── Usage (ASSUMPTION; Ofcom CMR 2026: 146 outgoing min/month average) ────
const SEG = {
  low:      { trusted: 40, unknown: 8, tc: 15, uc: 4, sms: 0 },
  normal:   { trusted: 150, unknown: 25, tc: 45, uc: 10, sms: 1 },
  high:     { trusted: 450, unknown: 60, tc: 120, uc: 20, sms: 2 },
  extreme:  { trusted: 1200, unknown: 300, tc: 300, uc: 100, sms: 4 },
  targeted: { trusted: 150, unknown: 120, tc: 45, uc: 80, sms: 6 },
};
const MIX = {
  central: { low: 0.33, normal: 0.44, high: 0.15, extreme: 0.04, targeted: 0.04 },
  stress:  { low: 0.10, normal: 0.35, high: 0.30, extreme: 0.15, targeted: 0.10 },
};
const ROUND = 0.55; // ASSUMPTION extra started minute per call at 60/60

// ── Architectures (per-minute and fixed, GBP) ────────────────────────────
function arch(key, { twilioBasis = 'billed' } = {}) {
  const tw = (b, l) => (twilioBasis === 'billed' ? p(b) : p(l));
  const sdk = twilioBasis === 'billed' ? p('twSdkBilled') : p('twSdkList');
  const A = {
    label: 'A Current Twilio',
    trustedPerMin: tw('twInboundBilled', 'twInboundList') + sdk, round: true,
    monitoredExtraPerMin: tw('twStreamBilled', 'twStreamList') + p('transcription'),
    perUnknownCall: p('twPolly'), numberPerSub: tw('twNumberBilled', 'twNumberList'),
    platformFixed: 0, infraPerSub: 0,
  };
  const B = {
    label: 'B Free-inbound UK SIP → Twilio BYOC → existing Voice SDK',
    trustedPerMin: p('sipInbound') + p('twByoc') + sdk, round: true, // + SIP interface if Twilio applies it (QUOTE)
    trustedPerMinIfSipIfaceAlso: p('sipInbound') + p('twByoc') + p('twSipIface') + sdk,
    monitoredExtraPerMin: tw('twStreamBilled', 'twStreamList') + p('transcription'),
    perUnknownCall: p('twPolly'), numberPerSub: p('sipNumber'), channelsPer1k: 22,
    platformFixed: 0, infraPerSub: 0,
  };
  const C = {
    label: 'C UK SIP carrier → HCG-owned SIP/WebRTC/VoIP-push delivery',
    trustedPerMin: p('sipInbound') + p('selfBandwidth'), round: false,
    monitoredExtraPerMin: p('selfBandwidth') + p('transcription'),
    perUnknownCall: 0.0002, numberPerSub: p('sipNumber'), channelsPer1k: 22,
    platformFixed: p('selfOpsStaff'), infraPerSub: p('selfInfraPer1k') / 1000,
  };
  const D = {
    label: 'D Network-side selective routing (unknown only to HCG, via C stack)',
    trustedPerMin: 0, round: false,
    monitoredExtraPerMin: p('selfBandwidth') + p('transcription'),
    perUnknownCall: 0.0002, numberPerSub: 0, channelsPer1k: 10,
    platformFixed: p('selfOpsStaff'), infraPerSub: p('selfInfraPer1k') / 2000,
    networkFee: null,
  };
  return { A, B, C, D }[key];
}

function revenue(price) {
  const net = price / (1 + p('vat'));
  const fee = p('storeShare') * net * p('storeFee') + (1 - p('storeShare')) * (price * p('stripePct') + p('stripeFixed'));
  return { vat: price - net, net, fee };
}

// Categories A–I per subscriber per month (portfolio average).
function cats(a, mix, subs) {
  const c = { A: 0, B: 0, C: 0, D: 0, G: 0, H: p('fraudReserve'), I: 0 };
  for (const [k, w] of Object.entries(mix)) {
    const s = SEG[k];
    const r = a.round ? ROUND : 0;
    const trusted = (s.trusted + r * s.tc) * a.trustedPerMin;
    const unknownTransport = (s.unknown + r * s.uc) * a.trustedPerMin + s.uc * a.perUnknownCall + s.sms * p('twSms');
    const ai = s.unknown * a.monitoredExtraPerMin;
    const cost = { A: trusted, B: unknownTransport, C: ai };
    const target = k === 'extreme' ? 'I' : null; // extreme users' transport reported in I
    if (target) { c.I += w * (cost.A + cost.B + cost.C); } else { c.A += w * cost.A; c.B += w * cost.B; c.C += w * cost.C; }
  }
  c.D = a.numberPerSub + ((a.channelsPer1k || 0) * p('sipChannel')) / 1000;
  c.G = a.infraPerSub + a.platformFixed / subs;
  c.total = c.A + c.B + c.C + c.D + c.G + c.H + c.I;
  return c;
}

// ── Output ───────────────────────────────────────────────────────────────
const out = [];
const w = (s = '') => out.push(s);
const t = (h, rows) => { w(`| ${h.join(' | ')} |`); w(`|${h.map(() => '---').join('|')}|`); rows.forEach((r) => w(`| ${r.join(' | ')} |`)); w(); };
const g = (n) => (n == null ? 'QUOTE' : (n < 0 ? '−£' : '£') + Math.abs(n).toFixed(n !== 0 && Math.abs(n) < 0.1 ? 5 : 2));
const pct = (n) => `${Math.round(n * 100)}%`;
const PRICES = [4.99, 5.99, 6.99, 7.99, 9.99];

w('# Four-architecture model output');
w();
w('## Price book (every leg, labelled)');
w();
t(['Item', '£', 'Label', 'Source'], Object.entries(P).map(([k, x]) => [k, x.v == null ? '—' : x.v.toFixed(6), x.l, x.s]));

w('## Option B leg by leg (per connected minute, GBP)');
w();
t(['Leg', 'Provider', 'Direction', '£/min', 'Fixed', 'Label'], [
  ['Caller → customer mobile → forwarded to HCG DDI', 'Customer\'s MNO', 'customer outbound (forward)', 'customer tariff', '—', `${L.ASM}: in bundle for most post-pay; PAYG may pay`],
  ['Forwarded call arrives on UK SIP DDI', 'Sipflex / sipgate / aql / Magrathea', 'inbound', g(p('sipInbound')), `${g(p('sipNumber'))}/number + ${g(p('sipChannel'))}/channel`, `${L.PUB} (volume terms ${L.QUOTE})`],
  ['SIP carrier → Twilio BYOC trunk', 'Twilio', 'BYOC origination into Twilio', g(p('twByoc')), '—', L.PUB],
  ['Twilio SIP interface (if also charged on BYOC calls)', 'Twilio', 'inbound SIP', g(p('twSipIface')), '—', `${L.PUB} price; applicability ${L.QUOTE}`],
  ['Twilio → HCG app (<Dial><Client>)', 'Twilio Voice SDK', 'outbound to client', `${g(p('twSdkBilled'))} billed / ${g(p('twSdkList'))} list`, '—', `${L.INV} (billed) / ${L.PUB} (list) — continuation for BYOC calls ${L.QUOTE}`],
  ['Media Stream (monitored only)', 'Twilio', 'fork', `${g(p('twStreamBilled'))} billed / ${g(p('twStreamList'))} list`, '—', `${L.INV} / ${L.PUB}`],
  ['Transcription (monitored only)', 'OpenAI', 'API', g(p('transcription')), '—', L.PUB],
  ['Greeting (unknown calls)', 'Twilio Polly', 'per call', g(p('twPolly')), '—', L.INV],
  ['VAT on supplier charges', 'HMRC', '—', 'reclaimable if VAT-registered', '—', L.ASM],
]);
const bB = arch('B', { twilioBasis: 'billed' }); const bL = arch('B', { twilioBasis: 'list' });
const aB = arch('A', { twilioBasis: 'billed' }); const aL = arch('A', { twilioBasis: 'list' });
t(['Trusted minute', 'Twilio billed basis', 'Twilio list basis'], [
  ['A current Twilio', g(aB.trustedPerMin), g(aL.trustedPerMin)],
  ['B SIP + BYOC + SDK', g(bB.trustedPerMin), g(bL.trustedPerMin)],
  ['B if Twilio also charges SIP interface', g(bB.trustedPerMinIfSipIfaceAlso), g(bL.trustedPerMinIfSipIfaceAlso)],
]);

for (const basis of ['billed', 'list']) {
  w(`## Portfolio economics per subscriber (1,000 subs), Twilio ${basis} basis`);
  w();
  w('A trusted · B unknown transport · C AI/streaming · D fixed subscriber (number/channels) · G infrastructure/ops · H fraud contingency · I extreme users (their A+B+C). E (payment fees) and F (VAT) are deducted from revenue.');
  w();
  for (const [mk, mix] of Object.entries(MIX)) {
    w(`### ${mk} mix`);
    w();
    t(['Architecture', 'A', 'B', 'C', 'D', 'G', 'H', 'I', 'Total', ...PRICES.map((x) => `margin £${x}`)], ['A', 'B', 'C'].map((k) => {
      const a = arch(k, { twilioBasis: basis });
      const c = cats(a, mix, 1000);
      return [a.label, g(c.A), g(c.B), g(c.C), g(c.D), g(c.G), g(c.H), g(c.I), `**${g(c.total)}**`, ...PRICES.map((pr) => { const r = revenue(pr); return pct((r.net - r.fee - c.total) / r.net); })];
    }));
  }
}
w('### Option C scale sensitivity (central mix, billed basis n/a): fixed ops/infra spread over subscribers');
w();
t(['Subscribers', 'C total £/sub', ...PRICES.map((x) => `margin £${x}`)], [500, 1000, 2500, 10000].map((n) => {
  const c = cats(arch('C'), MIX.central, n);
  return [n, g(c.total), ...PRICES.map((pr) => { const r = revenue(pr); return pct((r.net - r.fee - c.total) / r.net); })];
}));
{
  const c = cats(arch('D'), MIX.central, 2500);
  w(`Option D HCG-side cost at 2,500 subs (central): ${g(c.total)}/sub **plus the network fee (${L.QUOTE})**. Max affordable fee at 40%: ${PRICES.map((pr) => { const r = revenue(pr); return `£${pr} → ${g(r.net * 0.6 - r.fee - c.total)}`; }).join(' · ')}.`);
  w();
}

// ── Catastrophic exposure ─────────────────────────────────────────────────
w('## Catastrophic exposure (attacker maximising HCG\'s bill)');
w();
w('Parameters are ASSUMPTIONS chosen as a realistic motivated attacker, not a ceiling of what is possible. "Stopped by" names the first control **outside the attacker\'s reach**.');
w();
const hour = (channels, perMin) => channels * 60 * perMin;
const scen = [
  ['A', 'L0 external: inbound flood to HCG numbers, 500 concurrent unknown calls (botnet / hacked PBXs)', 'Nothing provider-side: Twilio has no inbound concurrency or spend cap. HCG app caps (unmerged) are app-controlled.', hour(500, aB.trustedPerMin + aB.monitoredExtraPerMin), 'per hour, unbounded in time'],
  ['A', 'L3 backend/env compromise (master Twilio auth token): outbound calls to high-cost international numbers, 1 CPS for 1 h, $1.50/min, 60 min each', 'Twilio geo-permissions are changeable with the same token → NOT independent. Only: prepaid balance without auto-recharge (CONSOLE setting; API-changeability UNCONFIRMED), Twilio fraud desk (UNCONFIRMED).', 3600 * 60 * usd(1.5), 'first hour of calls'],
  ['A', 'L3: buy numbers en masse (5,000 numbers)', 'None provider-side found', 5000 * p('twNumberList'), 'per month, recurring'],
  ['A', 'L3: OpenAI key misuse (LLM-jacking)', 'OpenAI prepaid credit with auto-recharge OFF (budgets are notification-only)', null, 'bounded by prepaid balance only if auto-recharge is off'],
  ['B', 'L0 inbound flood', 'SIP carrier channel count (provider-enforced; portal-only change)', hour(22, bB.trustedPerMin + bB.monitoredExtraPerMin), 'per hour at 22 channels — BOUNDED (but channel exhaustion is shared-fate DoS for all customers)'],
  ['B', 'L3 backend compromise: Twilio outbound fraud (same Twilio account still exists)', 'Same as A unless Twilio account is separate, number-less, geo-locked and the auth token is not held by the app backend', 3600 * 60 * usd(1.5), 'same as A — BLOCKER unless isolated'],
  ['C', 'L0 inbound flood', 'Carrier channel count + fixed-size HCG infra (no per-minute billing)', hour(22, arch('C').trustedPerMin + arch('C').monitoredExtraPerMin), 'per hour — BOUNDED (transcription is the only variable; prepaid)'],
  ['C', 'L3 backend compromise: outbound via SIP trunk', 'Carrier: trunk provisioned inbound-only / outbound barred at carrier (portal-only, MFA) → £0', 0, 'if carrier config confirmed (QUOTE)'],
  ['D', 'L0 inbound flood of unknown calls', 'Network diverts only unknown callers to HCG\'s DDI → same channel bound as C', hour(10, arch('D').monitoredExtraPerMin), 'per hour — BOUNDED'],
];
t(['Arch', 'Scenario', 'Stopped by (outside attacker control)', 'Exposure £', 'Basis'], scen.map((r) => [r[0], r[1], r[2], r[3] == null ? 'balance' : g(r[3]), r[4]]));

process.stdout.write(out.join('\n') + '\n');
