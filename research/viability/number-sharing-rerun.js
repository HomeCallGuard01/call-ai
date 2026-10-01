// Re-runs the subscription model across number-cost architectures:
// one number per household (retail / wholesale / own Ofcom range) and
// SHARED numbers at 1:2, 1:3, 1:10 and ~negligible. Sharing needs an
// HCG-controlled SIP edge proxy that reads the forwarded call's
// network-asserted diverting identity (NICC ND1016 RULE CLI TERM 5) and
// tags the call for Twilio — modelled as a fixed platform cost (ASSUMPTION).
// Research only. Run: node research/viability/number-sharing-rerun.js > research/viability/NUMBER_SHARING_OUTPUT.md
'use strict';
const m = require('./subscription-design.js');
const PRICES = [5.99, 6.99, 7.99, 9.99];
const FX = 0.79;
const gbp = (n) => (n < 0 ? '−£' : '£') + Math.abs(n).toFixed(2);
const pct = (n) => `${Math.round(n * 100)}%`;
const out = []; const w = (s = '') => out.push(s);
const t = (h, rows) => { w(`| ${h.join(' | ')} |`); w(`|${h.map(() => '---').join('|')}|`); rows.forEach((r) => w(`| ${r.join(' | ')} |`)); w(); };

const PROXY = 300; // £/month HA SIP edge proxy pair + monitoring (ASSUMPTION)
const HOSTING_PER_NUMBER = null; // own-range hosting fee: PROVIDER QUOTE REQUIRED
const NUMBER_CASES = [
  { name: '1 number/household, retail £2.00 (PUBLISHED)', perHh: 2.0, extra: 0 },
  { name: '1 number/household, wholesale £1.00 (QUOTE)', perHh: 1.0, extra: 0 },
  { name: '1 number/household, wholesale £0.50 (QUOTE)', perHh: 0.5, extra: 0 },
  { name: '1 number/household, own Ofcom range ~£0.10 incl. hosting (QUOTE; Ofcom charge ≤ 10p/number/YEAR)', perHh: 0.10, extra: 0 },
  { name: 'Shared 1:2 at £2.00 retail + SIP edge proxy', perHh: 2.0 / 2, extra: PROXY },
  { name: 'Shared 1:3 at £2.00 retail + proxy', perHh: 2.0 / 3, extra: PROXY },
  { name: 'Shared 1:10 at £2.00 retail + proxy', perHh: 2.0 / 10, extra: PROXY },
  { name: 'Shared ~negligible (1:100+) + proxy', perHh: 0.02, extra: PROXY },
];
const SDK = [['SDK leg at list (conservative)', 0.004 * FX], ['SDK leg £0 (as invoiced today)', 0]];

w('# Number-sharing / number-cost re-run');
w();
w('Full fully-loaded subscription model (`subscription-design.js`), 1,000 subscribers, Apple 15%. Each cell shows normal / heavy / stress margin. ✔ = normal ≥ 40% **and** heavy, stress ≥ 0%.');
w('The number cost includes the 5% quarantine overhead. The shared rows add a £' + PROXY + '/month SIP edge proxy (ASSUMPTION).');
w();
for (const [sdkName, sdk] of SDK) {
  w(`## ${sdkName}`);
  w();
  t(['Number architecture', 'Number £/hh', ...PRICES.map((p) => gbp(p)), 'Lowest compliant price'], NUMBER_CASES.map((c) => {
    const o = { twSdk: sdk, sipNumber: c.perHh, extraPlatform: c.extra };
    let lowest = 'none ≤ £9.99';
    const cells = PRICES.map((p) => {
      const n = m.margin(p, m.MIX.normal, { o }).m, h = m.margin(p, m.MIX.heavy, { o }).m, s = m.margin(p, m.MIX.stress, { o }).m;
      const ok = n >= 0.4 && h >= 0 && s >= 0; if (ok && lowest.startsWith('none')) lowest = gbp(p);
      return `${pct(n)} / ${pct(h)} / ${pct(s)}${ok ? ' ✔' : ''}`;
    });
    return [c.name, gbp(c.perHh * 1.05), ...cells, lowest];
  }));
}

w('## Per-price detail: own-range or near-zero numbers (£0.10/hh), SDK £0 vs list');
w();
for (const [sdkName, sdk] of SDK) {
  const o = { twSdk: sdk, sipNumber: 0.10 };
  const base = m.costs(m.MIX.normal, { o }).minutes;
  w(`### ${sdkName}`);
  w();
  t(['Price', 'Contribution £/sub', 'Normal', 'Heavy', 'Stress', 'Break-even avg min', 'Below 40% when avg min >'], PRICES.map((p) => {
    const n = m.margin(p, m.MIX.normal, { o });
    const f0 = m.solve((f) => m.margin(p, m.MIX.normal, { f, o }).m, 0.01, 50, 0);
    const f40 = m.solve((f) => m.margin(p, m.MIX.normal, { f, o }).m, 0.01, 50, 0.4);
    return [gbp(p), gbp(n.contrib), pct(n.m), pct(m.margin(p, m.MIX.heavy, { o }).m), pct(m.margin(p, m.MIX.stress, { o }).m), f0 ? Math.round(base * f0) : '—', f40 ? Math.round(base * f40) : 'never ≥ 40%'];
  }));
}
w(`Normal mix: ${Math.round(m.costs(m.MIX.normal).minutes)} avg forwarded min/sub/month (ASSUMPTION).`);
w();
process.stdout.write(out.join('\n') + '\n');
