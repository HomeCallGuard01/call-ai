// Customer allowance UI (2026-10-03): the web dashboard card and the mobile
// meter display the server's customerAllowance and never compute usage
// themselves; exhaustion copy never implies the phone service stops; the
// "monitoring" claims are gated on the server's monitoringActive.
// Structural (file content) checks, matching the repo's other UI tests —
// the repo's .env is production configuration, so the server isn't started.
// Run with: node tests/customer-allowance-ui.test.mjs

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const html = read('upload.html');
const renderStart = html.indexOf('function renderAllowance(a)');
const renderEnd = html.indexOf('function computeProtectionMessage(data, state)');
const render = html.slice(html.indexOf('function formatAllowanceDate(iso)'), renderEnd);

check(/id="allowanceCard"[^>]*hidden/.test(html), 'web: allowance card exists and starts hidden (older backends show nothing)');
check(/renderAllowance\(data\.customerAllowance\)/.test(html), 'web: card is rendered from the server field customerAllowance');
check(renderStart > 0 && /a\.status === "inactive"/.test(render) && /card\.hidden = true/.test(render), 'web: hidden for inactive memberships or a missing read model');
check(/a\.allowance\.remainingPercent/.test(render) && !/usedMinutes\s*[-/]/.test(render) && !/totalMinutes\s*[-/*]/.test(render) && !/100\s*-\s*/.test(render), 'web: shows the server\'s remainingPercent — no client-side usage arithmetic');
check(/role="meter"/.test(html) && /aria-valuenow/.test(render), 'web: the bar is an accessible meter');
check(/Resets on /.test(render), 'web: reset date shown');
check(/Your phone still works normally and every call still reaches you/.test(render) && !/disconnect|suspend|cut off/i.test(render), 'web: exhaustion says the phone and calls keep working; never "disconnected"/"suspended"');
check(/offer && offer\.available/.test(render) && /input\.name = "product"/.test(render) && /\/billing\/topup-checkout/.test(render), 'web: top-up buttons only when the server offers one; they submit only a product code');
check(/Extra minutes last until your allowance resets/.test(render), 'web: top-up expiry at reset is stated before purchase');
check(!/telephony|cost_gbp|£\/min|per minute cost/i.test(render), 'web: no internal telephony/cost data in the customer card');
const prot = html.slice(renderEnd, renderEnd + 2500);
check(/allowanceState\.monitoringActive === false/.test(prot) && prot.indexOf('allowanceState.monitoringActive === false') < prot.indexOf('variant: "protected"'), 'web: "monitored while you talk" is not shown when the server says monitoring is off');

// Execute the real web render code against a minimal DOM stub.
function runRender(model) {
  const els = {};
  const el = (id) => (els[id] ||= { id, hidden: false, textContent: '', innerHTML: '', style: {}, dataset: {}, attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); } });
  const document = {
    getElementById: (id) => el(id),
    createElement: (tag) => ({ tag, style: {}, children: [], appendChild(c) { this.children.push(c); } }),
  };
  vm.runInNewContext(render + '\nrenderAllowance(model);', { document, model });
  return els;
}
const base = { version: 1, status: 'low', tone: 'caution', monitoringActive: true,
  allowance: { remainingPercent: 24, resetsAt: '2026-10-12T09:00:00.000Z' },
  topUp: { available: true, products: [{ code: 'topup_small', minutes: 30, priceGbpInclVat: 2.99 }] } };
const low = runRender(base);
check(!low.allowanceCard.hidden && low.allowanceCard.dataset.tone === 'caution' && low.allowancePercent.textContent === '24%' && low.allowanceMeterFill.style.width === '24%', 'web render: 24% left, caution tone, bar at 24%');
check(low.allowanceReset.textContent === 'Resets on 12 October', 'web render: UK date for the reset');
const form = low.allowanceTopUp.children[0];
check(!low.allowanceTopUp.hidden && form.action === '/billing/topup-checkout' && form.children[0].value === 'topup_small' && /Add 30 minutes · £2\.99/.test(form.children[1].textContent), 'web render: one top-up button posting only the product code');
const ok = runRender({ ...base, status: 'ok', tone: 'good', allowance: { remainingPercent: 80, resetsAt: base.allowance.resetsAt } });
check(ok.allowanceTopUp.hidden && ok.allowanceMessage.hidden, 'web render: no message and no sales prompt while usage is fine');
const used = runRender({ ...base, status: 'used_up', tone: 'critical', monitoringActive: false, allowance: { remainingPercent: 0, resetsAt: base.allowance.resetsAt }, topUp: { available: false, products: [] } });
check(/won't be checked for scams until it resets on 12 October/.test(used.allowanceMessage.textContent) && used.allowanceTopUp.hidden, 'web render: exhausted (enforced) explains what stops and when it resets; no button when no offer');
const unknown = runRender({ ...base, status: 'unavailable', tone: 'neutral', monitoringActive: null, allowance: { remainingPercent: null, resetsAt: null }, topUp: { available: false, products: [] } });
check(unknown.allowancePercent.textContent === '—' && unknown.allowanceMeterFill.style.width === '0%', 'web render: unreadable usage shows a dash, never a guessed number');
const inactive = runRender({ ...base, status: 'inactive' });
check(inactive.allowanceCard.hidden === true, 'web render: hidden for an inactive membership');

const meter = read('mobile/components/AllowanceMeter.tsx');
check(/allowance\.allowance\.remainingPercent/.test(meter) && !/usedMinutes\s*[-/]/.test(meter) && !/100\s*-\s*/.test(meter), 'mobile: meter shows server remainingPercent, no client arithmetic');
check(/status === "inactive"\) return null/.test(meter) && /!allowance/.test(meter), 'mobile: renders nothing without a read model or for inactive memberships');
check(/accessibilityRole="progressbar"/.test(meter), 'mobile: meter is an accessible progress bar');
check(/Your phone still works normally and every call still reaches you/.test(meter) && !/disconnect|suspend|cut off/i.test(meter), 'mobile: exhaustion copy never implies the phone service stops');
check(!/from "\.\.\/lib\/theme"[\s\S]*#[0-9a-f]{6}/i.test(meter), 'mobile: no colour literals (theme only)');
const home = read('mobile/app/(tabs)/index.tsx');
// 1.0.2: the hero wording moved to mobile/lib/protectionView.ts (one place,
// shared by both platforms). Same rule: the monitoring-off check runs before
// the protected wording can be returned, and Home feeds it the server field.
// tests/mobile-protection-view.test.mjs executes the rule behaviourally.
const pview = read('mobile/lib/protectionView.ts');
check(/allowance: data!\.customerAllowance \?\? null/.test(home)
  && /al\.monitoringActive === false/.test(pview)
  && pview.indexOf('al.monitoringActive === false') < pview.indexOf('Home Call Guard is protecting calls to this phone'),
  'mobile: protection is not claimed when the server says monitoring is off');
check(/<AllowanceMeter allowance=\{data!\.customerAllowance\} \/>/.test(home), 'mobile: Home shows the meter from the server field');
const types = read('mobile/lib/types.ts');
check(/customerAllowance\?: CustomerAllowance;/.test(types) && /monitoringActive: boolean \| null;/.test(types), 'mobile: customerAllowance is optional in the response type (older backends)');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
