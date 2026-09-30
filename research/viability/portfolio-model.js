// HCG portfolio economics model — RESEARCH ONLY (2026-09-30).
// Subscription service with portfolio economics: no per-customer incoming-
// minute bundle is assumed anywhere. Prints Markdown tables.
// Run with: node research/viability/portfolio-model.js > research/viability/MODEL_OUTPUT.md
//
// Every input carries one label:
//   CONFIRMED  — CONFIRMED FROM HCG DATA/INVOICE (Twilio billing records / Pricing API for HCG's account, 2026-09)
//   PUBLISHED  — CURRENT PUBLISHED PROVIDER PRICE (URL in `source`)
//   ASSUMPTION — HCG modelling assumption (sensitivity shown)
//   QUOTE      — PROVIDER QUOTE REQUIRED (no price is invented: the model solves for the maximum HCG could pay)
'use strict';

const I = (value, label, source) => ({ value, label, source });

const INPUTS = {
  fxUsdToGbp: I(0.79, 'ASSUMPTION', 'Conservative USD→GBP (a weaker £ raises USD-priced costs)'),
  vatRate: I(0.2, 'PUBLISHED', 'UK standard VAT'),
  // Payment channels
  storeFeeOfNet: I(0.15, 'PUBLISHED', 'Apple Small Business Program / Google Play subscriptions 15% (Apple SBP enrolment UNCONFIRMED — 30% if not)'),
  stripePct: I(0.027, 'PUBLISHED', 'Stripe UK 1.5% + Billing 0.7% + Tax 0.5% (from 2026-09 research; not re-verified tonight)'),
  stripeFixed: I(0.2, 'PUBLISHED', 'Stripe UK 20p per charge'),
  storeShare: I(0.7, 'ASSUMPTION', 'Share of subscribers paying via App Store / Google Play (Play Billing needed on Android)'),
  // Twilio (today)
  twNumber: I(0.86917, 'CONFIRMED', 'Twilio Pricing API + 45 billed number-months'),
  twInbound: I(0.007558, 'CONFIRMED', 'Twilio Pricing API; per started minute; billable for the whole connected call incl. <Dial><Client> (Twilio Support)'),
  twAppLeg: I(0, 'CONFIRMED', '£0 billed on HCG account to date (list $0.004/min — risk)'),
  twStream: I(0.003329, 'CONFIRMED', 'Twilio billed usage: Media Streams'),
  twGreeting: I(0.0006, 'CONFIRMED', 'Twilio billed usage: Polly'),
  twSms: I(0.042325, 'CONFIRMED', 'Twilio Pricing API: SMS segment'),
  twByocUsd: I(0.004, 'PUBLISHED', 'https://www.twilio.com/en-us/changelog/bring-your-own-carrier-trunking-origination-price-reduced'),
  // Transcription
  transcriptionUsd: I(0.006, 'PUBLISHED', 'OpenAI whisper-1 list $0.006/min (HCG cannot read its own OpenAI costs)'),
  // Plivo
  plNumberUsd: I(0.85, 'PUBLISHED', 'https://www.plivo.com/voice/pricing/gb/'),
  plInboundUsd: I(0.0055, 'PUBLISHED', 'https://www.plivo.com/voice/pricing/gb/'),
  plSdkUsd: I(0.0033, 'PUBLISHED', 'https://www.plivo.com/voice/pricing/gb/ (SDK leg charged in addition)'),
  // UK free-inbound SIP carrier
  sipNumber: I(2.0, 'PUBLISHED', 'https://www.sipflex.co.uk/ (£2/number/month; wholesale range holders likely lower — QUOTE)'),
  sipInbound: I(0, 'PUBLISHED', 'sipflex / sipgate trunking: inbound calls free (range holder receives the 0.0377p FTR)'),
  sipChannel: I(1.0, 'PUBLISHED', 'https://www.sipflex.co.uk/ £1 per additional concurrent channel/month'),
  selfHostInfraPer1k: I(400, 'ASSUMPTION', 'Self-hosted SBC/media/TURN/push infra £/month per 1,000 subs (servers+bandwidth, excl. staff)'),
  // Usage-shape assumptions
  roundUpPerCall: I(0.55, 'ASSUMPTION', 'Extra started minute per call under 60/60 billing (observed call lengths)'),
  busyHourShare: I(0.1, 'ASSUMPTION', 'Share of a day\'s traffic in the busy hour (for channel sizing)'),
  abnormalReserve: I(0.10, 'ASSUMPTION', 'Expected abnormal-event cost per subscriber per month (floods/loops, bounded by Layer B)'),
  networkBypassFee: I(null, 'QUOTE', 'MNO/MVNE per-subscriber fee for network-side trusted routing — NOT PUBLISHED; model solves for the maximum payable'),
};
const v = (k) => INPUTS[k].value;
const usd = (k) => v(k) * v('fxUsdToGbp');

// Usage segments per subscriber per month (ASSUMPTION). Anchor: Ofcom CMR 2026 —
// average OUTGOING mobile call minutes 146/month per subscription in 2025,
// 164 for post-pay (https://www.ofcom.org.uk/…/communications-market-report-2026.pdf).
// Incoming assumed ≈ outgoing at portfolio level. Unforwarded customers'
// incoming minutes are the model's biggest unknown: MEASURE IN PILOT.
const SEGMENTS = {
  low:     { label: 'Low',     trusted: 40,   unknown: 8,   trustedCalls: 15,  unknownCalls: 4,   sms: 0 },
  normal:  { label: 'Normal',  trusted: 150,  unknown: 25,  trustedCalls: 45,  unknownCalls: 10,  sms: 1 },
  high:    { label: 'High',    trusted: 450,  unknown: 60,  trustedCalls: 120, unknownCalls: 20,  sms: 2 },
  extreme: { label: 'Extreme', trusted: 1200, unknown: 300, trustedCalls: 300, unknownCalls: 100, sms: 4 },
  targeted:{ label: 'Targeted by scammers', trusted: 150, unknown: 120, trustedCalls: 45, unknownCalls: 80, sms: 6 },
};

// Portfolio mixes for 1,000 subscribers (ASSUMPTION).
const MIXES = {
  light:   { label: 'Light-use base',   low: 0.50, normal: 0.38, high: 0.08, extreme: 0.02, targeted: 0.02 },
  central: { label: 'Central',          low: 0.33, normal: 0.44, high: 0.15, extreme: 0.04, targeted: 0.04 },
  heavy:   { label: 'Heavy / older, chatty base', low: 0.20, normal: 0.40, high: 0.25, extreme: 0.08, targeted: 0.07 },
  stress:  { label: 'Stress (adverse selection)', low: 0.10, normal: 0.35, high: 0.30, extreme: 0.15, targeted: 0.10 },
};

// Erlang B blocking → channels needed at ≤1% blocking.
function erlangChannels(erlangs, target = 0.01) {
  let b = 1;
  for (let n = 1; n < 10000; n++) {
    b = (erlangs * b) / (n + erlangs * b);
    if (b <= target) return n;
  }
  return Infinity;
}

// Architectures: per-subscriber rates (GBP).
function architectures(subs, avgMonthlyMinutes) {
  const dailyMin = (subs * avgMonthlyMinutes) / 30;
  const busyErlangs = (dailyMin * v('busyHourShare')) / 60;
  const channels = erlangChannels(busyErlangs);
  const channelPerSub = (channels * v('sipChannel')) / subs;
  const transcription = usd('transcriptionUsd');
  return {
    twilio: {
      label: 'A1 Twilio today (all legs on Twilio)', status: 'CONFIRMED',
      fixed: v('twNumber'), connected: v('twInbound') + v('twAppLeg'), started60: true,
      stream: v('twStream'), transcription, greeting: v('twGreeting'), sms: v('twSms'),
    },
    twilioAppLegList: {
      label: 'A1b Twilio if the app leg is billed at list', status: 'PUBLISHED risk',
      fixed: v('twNumber'), connected: v('twInbound') + 0.004 * v('fxUsdToGbp'), started60: true,
      stream: v('twStream'), transcription, greeting: v('twGreeting'), sms: v('twSms'),
    },
    plivo: {
      label: 'A2 Plivo (published)', status: 'PUBLISHED',
      fixed: usd('plNumberUsd'), connected: usd('plInboundUsd') + usd('plSdkUsd'), started60: true,
      stream: 0, transcription, greeting: v('twGreeting'), sms: v('twSms'),
    },
    sipByoc: {
      label: 'A3 UK free-inbound SIP numbers → Twilio BYOC → existing Voice SDK', status: 'PUBLISHED (app-leg £0 = QUOTE)',
      fixed: v('sipNumber') + channelPerSub, connected: v('sipInbound') + usd('twByocUsd') + v('twAppLeg'), started60: true,
      stream: v('twStream'), transcription, greeting: v('twGreeting'), sms: v('twSms'), channels,
    },
    sipSelf: {
      label: 'A4 UK free-inbound SIP numbers → HCG-hosted SIP/WebRTC + VoIP push (iOS PushKit/CallKit, Android FCM)', status: 'PUBLISHED + ASSUMPTION infra',
      fixed: v('sipNumber') + channelPerSub + v('selfHostInfraPer1k') / 1000, connected: 0, started60: false,
      stream: 0, transcription, greeting: 0.0002, sms: v('twSms'), channels,
    },
    network: {
      label: 'A5 Network-side trusted routing (MNO/MVNE); only unknown calls reach HCG (A4 stack)', status: 'QUOTE REQUIRED',
      fixed: v('sipNumber') * 0 + v('selfHostInfraPer1k') / 1000, connected: 0, started60: false, trustedFree: true,
      stream: 0, transcription, greeting: 0.0002, sms: v('twSms'), networkFee: null,
    },
  };
}

// Cost categories A–F (E computed separately) for one segment.
function segmentCost(arch, s) {
  const r = v('roundUpPerCall');
  const round = arch.started60 ? r : 0;
  const A = arch.trustedFree ? 0 : (s.trusted + round * s.trustedCalls) * arch.connected;
  const B = (s.unknown + round * s.unknownCalls) * arch.connected + s.unknownCalls * arch.greeting + s.sms * arch.sms;
  const C = arch.fixed;
  const D = s.unknown * (arch.stream + arch.transcription); // unknown calls monitored (30-min cap rarely binds at these lengths)
  const F = v('abnormalReserve');
  return { A, B, C, D, F, total: A + B + C + D + F };
}

function revenue(price) {
  const net = price / (1 + v('vatRate'));
  const store = net * v('storeFeeOfNet');
  const stripe = price * v('stripePct') + v('stripeFixed');
  const fee = v('storeShare') * store + (1 - v('storeShare')) * stripe;
  return { price, vat: price - net, net, fee, afterFees: net - fee };
}

// Max average telecom+AI cost (A+B+C+D+F) tolerable for a margin target.
const tolerable = (price, m) => { const r = revenue(price); return r.net * (1 - m) - r.fee; };

const PRICES = [4.99, 5.99, 6.99, 7.99, 9.99];
const MARGINS = [0.3, 0.4, 0.5, 0.6];
const gbp = (n) => (n < 0 ? '−£' : '£') + Math.abs(n).toFixed(2);
const pct = (n) => `${Math.round(n * 100)}%`;
const out = [];
const p = (s = '') => out.push(s);
const table = (h, rows) => { p(`| ${h.join(' | ')} |`); p(`|${h.map(() => '---').join('|')}|`); rows.forEach((r) => p(`| ${r.join(' | ')} |`)); p(); };

function portfolio(archKey, mixKey, subs = 1000) {
  const mix = MIXES[mixKey];
  const avgMin = Object.keys(SEGMENTS).reduce((s, k) => s + mix[k] * (SEGMENTS[k].trusted + SEGMENTS[k].unknown), 0);
  const arch = architectures(subs, avgMin)[archKey];
  const cats = { A: 0, B: 0, C: 0, D: 0, F: 0, total: 0 };
  for (const k of Object.keys(SEGMENTS)) {
    const c = segmentCost(arch, SEGMENTS[k]);
    for (const x of Object.keys(cats)) cats[x] += mix[k] * c[x];
  }
  return { arch, avgMin, cats };
}

p('# HCG portfolio economics — model output');
p();
p(`Generated ${new Date().toISOString().slice(0, 10)} by \`research/viability/portfolio-model.js\`. Research only; no price chosen.`);
p();
p('## Inputs and labels');
p();
table(['Input', 'Value', 'Label', 'Source'], Object.entries(INPUTS).map(([k, x]) => [k, x.value === null ? '—' : String(x.value), x.label, x.source]));

p('## Usage segments (per subscriber per month, ASSUMPTION)');
p();
p('Anchor: Ofcom CMR 2026 says average outgoing mobile minutes were 146/month in 2025 (164 post-pay). Incoming is assumed ≈ outgoing at portfolio level. **HCG has no measured distribution yet**: 0 genuine paying customers as of 2026-09-27.');
p();
table(['Segment', 'Trusted min', 'Unknown min', 'Trusted calls', 'Unknown calls', 'Warning SMS'], Object.values(SEGMENTS).map((s) => [s.label, s.trusted, s.unknown, s.trustedCalls, s.unknownCalls, s.sms]));
table(['Mix (1,000 subs)', 'Low', 'Normal', 'High', 'Extreme', 'Targeted', 'Avg min/sub'], Object.entries(MIXES).map(([k, m]) => [m.label, pct(m.low), pct(m.normal), pct(m.high), pct(m.extreme), pct(m.targeted), portfolio('twilio', k).avgMin.toFixed(0)]));

p('## 1. Tolerable average telecom + AI cost per subscriber (A+B+C+D+F)');
p();
p(`Revenue after VAT and the blended payment fee (${pct(v('storeShare'))} store at 15%, rest Stripe). A portfolio is viable at a margin if its average cost per subscriber is at or below the figure.`);
p();
table(['Price', 'Net ex-VAT', 'Blended fee', 'After fees', ...MARGINS.map((m) => `${pct(m)} margin`)], PRICES.map((price) => {
  const r = revenue(price);
  return [gbp(price), gbp(r.net), gbp(r.fee), gbp(r.afterFees), ...MARGINS.map((m) => gbp(tolerable(price, m)))];
}));

p('## 2. Average cost per subscriber by architecture and mix (1,000 subscribers)');
p();
p('A = trusted transport, B = unknown-call transport (+ greeting, SMS), C = fixed per subscriber (number, channels, infra), D = AI + streaming, F = abnormal reserve. E (VAT/fees) is in §1.');
p();
for (const mixKey of Object.keys(MIXES)) {
  p(`### ${MIXES[mixKey].label}`);
  p();
  const archs = architectures(1000, portfolio('twilio', mixKey).avgMin);
  table(['Architecture', 'A trusted', 'B unknown', 'C fixed', 'D AI/stream', 'F abnormal', 'Total', ...PRICES.map((x) => `margin @ ${gbp(x)}`)],
    Object.keys(archs).filter((k) => k !== 'network').map((k) => {
      const { cats } = portfolio(k, mixKey);
      return [archs[k].label, gbp(cats.A), gbp(cats.B), gbp(cats.C), gbp(cats.D), gbp(cats.F), `**${gbp(cats.total)}**`,
        ...PRICES.map((price) => pct((revenue(price).afterFees - cats.total) / revenue(price).net))];
    }));
}

p('## 3. Network-side trusted routing: the maximum per-subscriber fee HCG could pay a carrier/MVNE');
p();
p('A5 removes trusted transport (A) from HCG entirely; HCG carries only unknown calls. The carrier fee is **PROVIDER QUOTE REQUIRED**, so the model gives the most HCG could pay per subscriber per month and still hit each margin (central mix).');
p();
{
  const { cats } = portfolio('network', 'central');
  table(['Price', ...MARGINS.map((m) => `max fee @ ${pct(m)}`)], PRICES.map((price) => [gbp(price), ...MARGINS.map((m) => gbp(tolerable(price, m) - cats.total))]));
  p(`HCG-side cost with A5 (central mix): ${gbp(cats.total)} per subscriber (B ${gbp(cats.B)}, C ${gbp(cats.C)}, D ${gbp(cats.D)}, F ${gbp(cats.F)}).`);
  p();
}

p('## 4. Break-even: average TRUSTED minutes per subscriber a portfolio can carry at 40% margin');
p();
p('Holding the central mix\'s unknown/monitored usage and fixed costs constant and solving for average trusted minutes.');
p();
{
  const rows = [];
  const archs = architectures(1000, portfolio('twilio', 'central').avgMin);
  for (const k of ['twilio', 'twilioAppLegList', 'plivo', 'sipByoc', 'sipSelf']) {
    const { cats } = portfolio(k, 'central');
    const perTrustedMin = archs[k].connected * (1 + (archs[k].started60 ? v('roundUpPerCall') / 3.3 : 0));
    const nonTrusted = cats.total - cats.A;
    rows.push([archs[k].label, ...PRICES.map((price) => {
      if (perTrustedMin === 0) return 'unbounded';
      const t = (tolerable(price, 0.4) - nonTrusted) / perTrustedMin;
      return t > 0 ? `${Math.floor(t)}` : '—';
    })]);
  }
  table(['Architecture', ...PRICES.map((x) => gbp(x))], rows);
  const sipCentral = architectures(1000, portfolio('twilio', 'central').avgMin).sipByoc;
  p(`Channel sizing (Erlang B, 1% blocking, central mix, 1,000 subscribers): ${sipCentral.channels} concurrent SIP channels.`);
  p();
}

p('## 5. 1,000-subscriber portfolio P&L (monthly contribution, £)');
p();
for (const k of ['twilio', 'sipByoc', 'sipSelf']) {
  const archs = architectures(1000, 150);
  p(`### ${archs[k].label}`);
  p();
  table(['Mix', ...PRICES.map((x) => gbp(x))], Object.keys(MIXES).map((mixKey) => {
    const { cats } = portfolio(k, mixKey);
    return [MIXES[mixKey].label, ...PRICES.map((price) => gbp(1000 * (revenue(price).afterFees - cats.total)))];
  }));
}

p('## 6. Sensitivity: A4 (usage-independent architecture) vs number price and infrastructure');
p();
p('A4\'s cost is almost entirely fixed per subscriber, so its margin depends on **number rental** (Sipflex publishes £2/month retail; a wholesale range-holder price is **PROVIDER QUOTE REQUIRED**) and on self-hosted infrastructure (**ASSUMPTION**). The values below are **sensitivity points, not prices**. Central mix, 1,000 subscribers; each cell shows the margin at £4.99 / £5.99 / £6.99.');
p();
{
  const base = portfolio('sipSelf', 'central').cats;
  const baseNumber = v('sipNumber');
  const baseInfra = v('selfHostInfraPer1k') / 1000;
  const rows = [];
  for (const num of [0.5, 1.0, 1.5, 2.0]) {
    rows.push([`number £${num.toFixed(2)}`, ...[200, 400, 800, 1600].map((infra) => {
      const total = base.total - baseNumber - baseInfra + num + infra / 1000;
      return [4.99, 5.99, 6.99].map((price) => pct((revenue(price).afterFees - total) / revenue(price).net)).join(' / ');
    })]);
  }
  table(['Number £/month', 'infra £200/1k', 'infra £400/1k', 'infra £800/1k', 'infra £1,600/1k'], rows);
  p('Maximum number rental A4 can afford at 40% margin (central mix, £400/1k infra):');
  p();
  table(['Price', 'Max £/number/month @ 40%', '@ 50%'], PRICES.map((price) => [gbp(price),
    gbp(tolerable(price, 0.4) - (base.total - baseNumber)), gbp(tolerable(price, 0.5) - (base.total - baseNumber))]));
}

process.stdout.write(out.join('\n') + '\n');
module.exports = { INPUTS, SEGMENTS, MIXES, architectures, segmentCost, revenue, tolerable, portfolio, erlangChannels };
