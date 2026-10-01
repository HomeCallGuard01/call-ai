// HCG subscription design model — cheapest price that meets ALL of:
//   (1) ≥40% contribution margin under NORMAL usage (central mix)
//   (2) solvent (≥0%) under HIGH legitimate usage (heavy and stress mixes)
//   (3) a hard, EXTERNALLY enforced maximum loss under abuse/attack
// Research only. Architecture: Option B (free-inbound UK SIP carrier →
// Twilio BYOC → existing Voice SDK) with provider-side containment, the
// only buildable architecture with an externally enforceable loss bound
// (CATASTROPHIC_RISK_REVIEW.md).
// Run: node research/viability/subscription-design.js > research/viability/SUBSCRIPTION_DESIGN_OUTPUT.md
'use strict';

const L = { INV: 'CONFIRMED HCG INVOICE', PUB: 'PUBLISHED', PUBNV: 'PUBLISHED (not re-verified in this session)', QUOTE: 'PROVIDER QUOTE REQUIRED', ASM: 'ASSUMPTION' };
const FX = 0.79; // ASSUMPTION USD→GBP (conservative)

// ── Inputs ────────────────────────────────────────────────────────────────
const IN = {
  // Revenue side
  vat:            [0.20, L.PUB, 'UK VAT on the VAT-inclusive price'],
  shareIos:       [0.45, L.ASM, 'Payment mix: Apple IAP'],
  shareAndroid:   [0.35, L.ASM, 'Payment mix: Google Play Billing (required for Android in-app)'],
  shareWeb:       [0.20, L.ASM, 'Payment mix: Stripe (web)'],
  appleFee:       [0.15, L.PUBNV, 'Apple Small Business Program 15% of net — HCG enrolment UNCONFIRMED (30% otherwise)'],
  googleFee:      [0.15, L.PUBNV, 'Google Play subscriptions 15% of net'],
  stripePct:      [0.027, L.PUBNV, 'Stripe UK 1.5% + Billing 0.7% + Tax 0.5%'],
  stripeFixed:    [0.20, L.PUBNV, 'Stripe UK 20p per charge'],
  refundRate:     [0.02, L.ASM, 'Share of gross revenue refunded (store + Stripe)'],
  chargebackRate: [0.003, L.ASM, 'Stripe subscriptions disputed per month'],
  disputeFee:     [20, L.ASM, 'Stripe UK dispute fee £ (believed £20; verify)'],
  // Telecom (Option B)
  sipNumber:      [2.00, L.PUB, 'sipflex.co.uk £2/number/month retail (wholesale range-holder price QUOTE)'],
  numberOverhead: [0.05, L.ASM, 'Extra numbers held in quarantine/lifecycle per active household'],
  sipInbound:     [0, L.PUB, 'Free inbound at retail (sipflex, sipgate) — at-volume terms QUOTE'],
  sipChannel:     [1.00, L.PUB, 'sipflex.co.uk £1/concurrent channel/month'],
  channelHeadroom:[1.3, L.ASM, 'Channels = Erlang-B(1% blocking) × 1.3'],
  twByoc:         [0.004 * FX, L.PUB, 'Twilio BYOC $0.0040/min (twilio.com/…/pricing/gb); HCG not yet billed; increment QUOTE'],
  twSdk:          [0.004 * FX, L.PUB, 'Twilio Voice SDK $0.0040/min list — HCG billed £0 to date (INVOICE); for BYOC calls QUOTE → design uses LIST'],
  twStream:       [0.0044 * FX, L.PUB, 'Twilio Media Streams $0.0044/min list (HCG billed £0.00333)'],
  twPolly:        [0.0006, L.INV, 'Greeting per unknown call'],
  twSms:          [0.042325, L.INV, 'SMS segment (warning SMS)'],
  roundUp:        [0.55, L.ASM, 'Extra started minute per call on per-minute Twilio legs'],
  transcription:  [0.006 * FX, L.PUB, 'OpenAI whisper-1 $0.006/min'],
  // Platform (monthly, £) — fully loaded, excludes founder salary and marketing/CAC
  railway:        [50, L.ASM, 'Railway compute ≤1k subs; +£20 per extra 1k'],
  supabase:       [25 * FX + 10, L.PUBNV, 'Supabase Pro $25 + compute add-on (ASM £10)'],
  email:          [16, L.ASM, 'Transactional email (Resend or similar)'],
  appleDev:       [99 * FX / 12, L.PUBNV, 'Apple Developer Program $99/yr'],
  monitoring:     [30, L.ASM, 'Error monitoring, uptime, logs, domain/DNS'],
  tokenService:   [10, L.ASM, 'Isolated Voice-token minting service (credential isolation)'],
  insurance:      [100, L.ASM, 'Cyber + tech PI premium (broker quote required before scale)'],
  // Support (per active subscriber per month, £)
  supportPerSub:  [0.30, L.ASM, 'Ongoing: ~6% of subs contact per month × £5 handling'],
  onboardingPerSub:[0.125, L.ASM, 'Forwarding set-up help: 30% of new subs × 15 min × £20/h, over a 12-month life'],
  fraudReserve:   [0.10, L.ASM, 'Expected abuse cost within the hard bounds'],
};
const v = (k) => IN[k][0];

// ── Usage (ASSUMPTION; Ofcom CMR 2026 anchor 146 outgoing min/month) ─────
const SEG = {
  low:      { trusted: 40, unknown: 8, tc: 15, uc: 4, sms: 0 },
  normal:   { trusted: 150, unknown: 25, tc: 45, uc: 10, sms: 1 },
  high:     { trusted: 450, unknown: 60, tc: 120, uc: 20, sms: 2 },
  extreme:  { trusted: 1200, unknown: 300, tc: 300, uc: 100, sms: 4 },
  targeted: { trusted: 150, unknown: 120, tc: 45, uc: 80, sms: 6 },
};
const MIX = {
  normal: { label: 'Normal (central)', low: 0.33, normal: 0.44, high: 0.15, extreme: 0.04, targeted: 0.04 },
  heavy:  { label: 'High legitimate (heavy)', low: 0.20, normal: 0.40, high: 0.25, extreme: 0.08, targeted: 0.07 },
  stress: { label: 'High legitimate (stress)', low: 0.10, normal: 0.35, high: 0.30, extreme: 0.15, targeted: 0.10 },
};

function erlangChannels(erl) { let b = 1; for (let n = 1; n < 100000; n++) { b = (erl * b) / (n + erl * b); if (b <= 0.01) return n; } return Infinity; }

function usage(mix, f = 1) {
  const u = { trusted: 0, unknown: 0, tc: 0, uc: 0, sms: 0 };
  for (const k of Object.keys(SEG)) for (const x of Object.keys(u)) u[x] += (mix[k] || 0) * SEG[k][x] * (x === 'sms' ? 1 : f);
  return u;
}

// Overrides let the threshold solver move one driver at a time.
function costs(mix, { subs = 1000, f = 1, o = {} } = {}) {
  const g = (k) => (o[k] !== undefined ? o[k] : v(k));
  const u = usage(mix, f);
  const connected = g('sipInbound') + g('twByoc') + g('twSdk');
  const monitoredExtra = g('twStream') + g('transcription');
  const minutes = u.trusted + u.unknown;
  const channels = Math.ceil(erlangChannels((subs * minutes / 30 * 0.1) / 60) * v('channelHeadroom'));
  const platform = (o.extraPlatform || 0) + v('railway') + Math.max(0, subs / 1000 - 1) * 20 + v('supabase') + v('email') + v('appleDev') + v('monitoring') + v('tokenService') + (o.insurance !== undefined ? o.insurance : v('insurance'));
  const c = {
    trusted: (u.trusted + v('roundUp') * u.tc) * connected,
    unknownTransport: (u.unknown + v('roundUp') * u.uc) * connected + u.uc * v('twPolly'),
    aiStreaming: u.unknown * monitoredExtra,
    sms: u.sms * v('twSms'),
    numbers: g('sipNumber') * (1 + v('numberOverhead')),
    channels: (channels * v('sipChannel')) / subs,
    platform: platform / subs,
    support: g('supportPerSub') + v('onboardingPerSub'),
    fraud: v('fraudReserve'),
  };
  c.total = Object.values(c).reduce((s, x) => s + x, 0);
  return { c, u, channels, minutes };
}

function revenue(price, o = {}) {
  const g = (k) => (o[k] !== undefined ? o[k] : v(k));
  const net = price / (1 + v('vat'));
  const storeFee = v('shareIos') * net * g('appleFee') + v('shareAndroid') * net * v('googleFee');
  const stripeFee = v('shareWeb') * (price * v('stripePct') + v('stripeFixed'));
  const refunds = g('refundRate') * net;
  const disputes = v('shareWeb') * v('chargebackRate') * v('disputeFee');
  return { price, vat: price - net, net, storeFee, stripeFee, refunds, disputes, netAfter: net - storeFee - stripeFee - refunds - disputes };
}

const margin = (price, mix, opts = {}) => { const r = revenue(price, opts.o || {}); const k = costs(mix, opts); return { m: (r.netAfter - k.c.total) / r.net, contrib: r.netAfter - k.c.total, r, k }; };

// Bisection on any scalar driver: find value where margin == target.
function solve(fn, lo, hi, target) {
  let flo = fn(lo) - target; const fhi = fn(hi) - target;
  if (Math.sign(flo) === Math.sign(fhi)) return null;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; const fm = fn(mid) - target; if (Math.sign(fm) === Math.sign(flo)) { lo = mid; flo = fm; } else hi = mid; }
  return (lo + hi) / 2;
}

// ── Output ────────────────────────────────────────────────────────────────
const out = []; const w = (s = '') => out.push(s);
const t = (h, rows) => { w(`| ${h.join(' | ')} |`); w(`|${h.map(() => '---').join('|')}|`); rows.forEach((r) => w(`| ${r.join(' | ')} |`)); w(); };
const gbp = (n) => (n < 0 ? '−£' : '£') + Math.abs(n).toFixed(2);
const pct = (n) => `${Math.round(n * 100)}%`;
const PRICES = [5.99, 6.99, 7.99, 9.99];

w('# Subscription design model output');
w();
w('## Inputs');
w();
t(['Input', 'Value', 'Label', 'Note'], Object.entries(IN).map(([k, [val, lab, note]]) => [k, typeof val === 'number' ? (Math.abs(val) < 0.1 ? val.toFixed(5) : val.toFixed(2)) : val, lab, note]));

w('## Revenue waterfall per subscriber per month');
w();
t(['Price', 'VAT', 'Net', 'Store fees', 'Stripe fees', 'Refunds', 'Disputes', 'Net after payment'], PRICES.map((p) => { const r = revenue(p); return [gbp(p), gbp(r.vat), gbp(r.net), gbp(r.storeFee), gbp(r.stripeFee), gbp(r.refunds), gbp(r.disputes), `**${gbp(r.netAfter)}**`]; }));

for (const subs of [1000]) {
  w(`## Cost stack per subscriber (${subs} subscribers)`);
  w();
  t(['Mix', 'Avg min', 'Trusted', 'Unknown transport', 'AI + streams', 'SMS', 'Numbers', 'Channels', 'Platform', 'Support', 'Fraud', 'Total', 'Channels needed'], Object.entries(MIX).map(([, mix]) => {
    const { c, minutes, channels } = costs(mix, { subs });
    return [mix.label, minutes.toFixed(0), gbp(c.trusted), gbp(c.unknownTransport), gbp(c.aiStreaming), gbp(c.sms), gbp(c.numbers), gbp(c.channels), gbp(c.platform), gbp(c.support), gbp(c.fraud), `**${gbp(c.total)}**`, channels];
  }));
}

w('## Contribution margin by price, usage mix and scale');
w();
for (const subs of [500, 1000, 2500, 5000]) {
  w(`### ${subs} subscribers`);
  w();
  t(['Mix', ...PRICES.map((p) => gbp(p))], Object.entries(MIX).map(([, mix]) => [mix.label, ...PRICES.map((p) => { const x = margin(p, mix, { subs }); return `${pct(x.m)} (${gbp(x.contrib)})`; })]));
}

w('## Break-even usage (1,000 subscribers; the normal mix scaled up or down)');
w();
w('Average forwarded minutes per subscriber per month at which the margin falls to 40% and to 0%. Monitored share and call lengths are held at the normal mix.');
w();
t(['Price', 'Avg min @ 40% margin', 'Avg min @ break-even (0%)', 'Normal mix today'], PRICES.map((p) => {
  const base = costs(MIX.normal).minutes;
  const f40 = solve((f) => margin(p, MIX.normal, { f }).m, 0.01, 50, 0.4);
  const f0 = solve((f) => margin(p, MIX.normal, { f }).m, 0.01, 50, 0);
  return [gbp(p), f40 ? `${Math.round(base * f40)} min` : 'never reaches 40%', f0 ? `${Math.round(base * f0)} min` : '—', `${Math.round(base)} min`];
}));

w('## Exactly where each price crosses 40% (normal mix, 1,000 subs, conservative base; one driver moved at a time)');
w();
const drivers = [
  ['Avg forwarded minutes / sub', (p, x) => margin(p, MIX.normal, { f: x / costs(MIX.normal).minutes }).m, 10, 3000, (x) => `> ${Math.round(x)} min`],
  ['Subscribers (fixed-cost dilution)', (p, x) => margin(p, MIX.normal, { subs: x }).m, 50, 100000, (x) => `< ${Math.round(x)} subs`],
  ['Number rental £/month', (p, x) => margin(p, MIX.normal, { o: { sipNumber: x } }).m, 0, 10, (x) => `> £${x.toFixed(2)}`],
  ['Twilio connected £/min (BYOC + SDK)', (p, x) => margin(p, MIX.normal, { o: { twByoc: x, twSdk: 0 } }).m, 0, 0.05, (x) => `> £${x.toFixed(4)}/min`],
  ['Transcription price multiple', (p, x) => margin(p, MIX.normal, { o: { transcription: v('transcription') * x } }).m, 0, 100, (x) => `> ${x.toFixed(1)}× list`],
  ['Apple commission', (p, x) => margin(p, MIX.normal, { o: { appleFee: x } }).m, 0, 0.6, (x) => `> ${Math.round(x * 100)}%`],
  ['Refund rate', (p, x) => margin(p, MIX.normal, { o: { refundRate: x } }).m, 0, 0.9, (x) => `> ${Math.round(x * 100)}% of revenue`],
  ['Support £/sub/month', (p, x) => margin(p, MIX.normal, { o: { supportPerSub: x } }).m, 0, 20, (x) => `> £${x.toFixed(2)}`],
  ['Insurance £/month', (p, x) => margin(p, MIX.normal, { o: { insurance: x } }).m, 0, 20000, (x) => `> £${Math.round(x)}`],
];
t(['Driver (base)', ...PRICES.map((p) => `${gbp(p)} (base ${pct(margin(p, MIX.normal).m)})`)], drivers.map(([name, fn, lo, hi, fmt]) => [name, ...PRICES.map((p) => {
  const base = margin(p, MIX.normal).m;
  const x = solve((val) => fn(p, val), lo, hi, 0.4);
  if (x == null) return base >= 0.4 ? 'never falls below (in range)' : 'cannot reach 40% (in range)';
  return base >= 0.4 ? `falls below 40% if ${fmt(x)}` : `reaches 40% only if ${fmt(x).replace('>', '≤').replace('<', '≥')}`;
})]));

w('## Stress checks at the base scale (1,000 subs)');
w();
const scen = [
  ['Base', {}],
  ['Apple SBP not granted (30%)', { appleFee: 0.3 }],
  ['Twilio bills the SDK leg AND SIP interface on BYOC calls', { twSdk: 0.004 * FX * 2 }],
  ['SDK leg stays £0 (as billed today)', { twSdk: 0 }],
  ['Wholesale numbers at £1.00 (QUOTE)', { sipNumber: 1.0 }],
  ['Refunds 5%', { refundRate: 0.05 }],
  ['Support 2× (£0.60)', { supportPerSub: 0.6 }],
];
for (const [mk, mix] of Object.entries(MIX)) {
  w(`### ${mix.label}`);
  w();
  t(['Scenario', ...PRICES.map((p) => gbp(p))], scen.map(([n, o]) => [n, ...PRICES.map((p) => pct(margin(p, mix, { o }).m))]));
}

// ── Scenario grid: the two unverified inputs that dominate ─────────────────
const GRID = [];
for (const sdk of [['SDK leg at list (conservative)', 0.004 * FX], ['SDK leg £0 (as invoiced today)', 0]]) {
  for (const num of [2.0, 1.0, 0.5]) {
    for (const apple of [0.15, 0.3]) GRID.push({ name: `${sdk[0]}; numbers £${num.toFixed(2)}; Apple ${Math.round(apple * 100)}%`, o: { twSdk: sdk[1], sipNumber: num, appleFee: apple } });
  }
}
w('## Scenario grid (1,000 subscribers): normal ≥40% · heavy ≥0% · stress ≥0%');
w();
w('Each cell shows normal / heavy / stress margin. ✔ = all three conditions met. Numbers £2.00 = published retail (Sipflex); £1.00 / £0.50 = wholesale sensitivity points, **not prices** (QUOTE).');
w();
t(['Scenario', ...PRICES.map((x) => gbp(x)), 'Lowest compliant price'], GRID.map((g) => {
  let lowest = 'none ≤ £9.99';
  const cells = PRICES.map((p) => {
    const n = margin(p, MIX.normal, { o: g.o }).m; const h = margin(p, MIX.heavy, { o: g.o }).m; const st = margin(p, MIX.stress, { o: g.o }).m;
    const ok = n >= 0.4 && h >= 0 && st >= 0;
    if (ok && lowest === 'none ≤ £9.99') lowest = gbp(p);
    return `${pct(n)} / ${pct(h)} / ${pct(st)}${ok ? ' ✔' : ''}`;
  });
  return [g.name, ...cells, lowest];
}));

w('## Per-price detail under the best-evidenced plausible case (SDK £0 as invoiced; numbers £1.00 wholesale — QUOTE; Apple 15%)');
w();
{
  const o = { twSdk: 0, sipNumber: 1.0, appleFee: 0.15 };
  const base = costs(MIX.normal, { o }).minutes;
  t(['Price', 'Contribution £/sub (normal)', 'Margin normal', 'Margin heavy', 'Margin stress', 'Break-even avg min', 'Margin < 40% above avg min'], PRICES.map((p) => {
    const n = margin(p, MIX.normal, { o }); const h = margin(p, MIX.heavy, { o }); const st = margin(p, MIX.stress, { o });
    const f0 = solve((f) => margin(p, MIX.normal, { f, o }).m, 0.01, 50, 0);
    const f40 = solve((f) => margin(p, MIX.normal, { f, o }).m, 0.01, 50, 0.4);
    return [gbp(p), gbp(n.contrib), pct(n.m), pct(h.m), pct(st.m), f0 ? `${Math.round(base * f0)}` : '—', f40 ? `${Math.round(base * f40)}` : 'never ≥ 40%'];
  }));
  w(`Normal mix today: ${Math.round(base)} avg forwarded min/sub/month (ASSUMPTION; Ofcom 146 outgoing min anchor).`);
  w();
}

// ── Individual households (no averaging) ──────────────────────────────────
w('## Individual households: loss per household and its hard bound (no averaging)');
w();
{
  const rows = [];
  for (const [name, o] of [['Conservative (SDK list, £2 numbers)', {}], ['Best-evidenced (SDK £0, £1 numbers)', { twSdk: 0, sipNumber: 1.0 }]]) {
    for (const seg of ['normal', 'high', 'extreme', 'targeted']) {
      const one = { [seg]: 1 };
      const k = costs(one, { o });
      rows.push([name, seg, `${Math.round(k.minutes)} min`, gbp(k.c.total), ...PRICES.map((p) => gbp(revenue(p).netAfter - k.c.total))]);
    }
  }
  t(['Case', 'Household', 'Minutes', 'Cost/month', ...PRICES.map((p) => `contribution @ ${gbp(p)}`)], rows);
  const perMin = v('twByoc') + v('twSdk');
  w(`**Hard per-household bound (external):** the carrier's per-DID channel cap (QUOTE) × every minute of the month × the Twilio connected rate. At 1 channel: ${gbp(43200 * perMin)}/month; at 2 channels: ${gbp(2 * 43200 * perMin)}/month (conservative rates). This is the most any single household, loop or attacker on one number can cost HCG in transport, whatever HCG\'s code does. Tighter bounds (e.g. £10/day) exist only in HCG's own code, so they are not external.`);
  w();
}

// ── Hard external maximum loss ─────────────────────────────────────────────
w('## Hard, externally enforced maximum loss (Option B with containment)');
w();
w('Every term is a **provider-side** bound that HCG\'s own compromised code or credentials cannot raise. Each is **PROVIDER CONFIRMATION REQUIRED**.');
w();
for (const subs of [1000, 5000]) {
  const { c, channels } = costs(MIX.normal, { subs });
  const twilioMonthly = subs * (c.trusted + c.unknownTransport + c.sms + (c.aiStreaming - usage(MIX.normal).unknown * v('transcription')));
  const aiMonthly = subs * usage(MIX.normal).unknown * v('transcription');
  const twFloat = twilioMonthly * 14 / 30;
  const aiFloat = aiMonthly * 14 / 30;
  const worstLeg = v('twByoc') + v('twSdk') + v('twByoc') + v('twStream') + v('transcription'); // + SIP interface if charged
  const overrun = channels * 240 * worstLeg; // in-flight calls complete after suspension (≤ carrier channels × Twilio 4-h max)
  const railwayCap = 150 + subs / 1000 * 40;
  const carrierCredit = subs * c.numbers * 0.25 + channels * v('sipChannel');
  const total = twFloat + overrun + aiFloat + railwayCap + carrierCredit;
  w(`### ${subs} subscribers`);
  w();
  t(['Bound', 'Mechanism (provider-enforced)', '£'], [
    ['Twilio (dedicated delivery account)', 'Prepaid float = 14 days of normal spend, **auto-recharge OFF**; account holds no numbers; outbound voice + international SMS disabled and **locked against API change** (Twilio must confirm)', gbp(twFloat)],
    ['Twilio in-flight overrun at suspension', `Calls in progress complete: ≤ carrier channels (${channels}) × 240 min (Twilio max call length) × worst leg rate`, gbp(overrun)],
    ['OpenAI', 'Prepaid credit = 14 days, auto-recharge OFF (budgets are soft)', gbp(aiFloat)],
    ['SIP carrier', 'Inbound-only trunk (outbound barred at carrier), IP-auth, account channel cap, per-DID cap, prepaid/credit limit ≈ 1 week of rental + channels', gbp(carrierCredit)],
    ['Railway / Supabase', 'Railway hard limit; Supabase spend cap on', gbp(railwayCap)],
    ['**Maximum loss per incident**', 'Sum; replenishment only by a human after review', `**${gbp(total)}**`],
  ]);
  w(`= ${pct(total / (subs * revenue(6.99).netAfter))} of one month's net revenue at £6.99. When a float is exhausted, service stops for all customers until a human tops it up (the forwarding deficiency). Floats must be sized against that outage risk, not only the loss.`);
  w();
}

// Cheapest compliant price
w('## Cheapest price meeting all three conditions (1,000 subscribers)');
w();
t(['Price', 'Normal ≥ 40%', 'Heavy ≥ 0%', 'Stress ≥ 0%', 'Normal ≥ 40% if Apple 30%', 'Normal ≥ 40% if SDK + SIP charged', 'All pass (base)'], PRICES.map((p) => {
  const n = margin(p, MIX.normal).m; const h = margin(p, MIX.heavy).m; const s = margin(p, MIX.stress).m;
  const a30 = margin(p, MIX.normal, { o: { appleFee: 0.3 } }).m; const sip = margin(p, MIX.normal, { o: { twSdk: 0.004 * FX * 2 } }).m;
  const ok = (x, th) => (x >= th ? `✓ ${pct(x)}` : `✗ ${pct(x)}`);
  return [gbp(p), ok(n, 0.4), ok(h, 0), ok(s, 0), ok(a30, 0.4), ok(sip, 0.4), n >= 0.4 && h >= 0 && s >= 0 ? '**YES**' : 'no'];
}));

if (require.main === module) process.stdout.write(out.join("\n") + "\n");
module.exports = { margin, MIX, solve, costs };
