// Structural tests for the touch-friendly device/provider picker cards
// in upload.html (2026-09-20) — replaces the old small <select>/<option>
// and bare radio-label controls with large tappable cards, matching the
// mobile app's device-picker.tsx usability. Presentation-only change:
// every underlying <input>/<select> id, name, value and option list is
// required to be byte-identical to before, since all eligibility/gate
// logic (carrier compatibility, iPhone-coming-soon, landline provider
// support, Stripe eligibility) reads those same elements/values
// unchanged. Same conventions as the rest of this project: no HTTP test
// tooling exists, so upload.html's real markup + inline script are
// checked directly against source — see tests/get-protected-now-button.test.mjs
// for the same idiom.
//
// Run with: node tests/onboarding-device-picker-cards.test.mjs

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'upload.html'), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// ============================================================
// The established brand green — must be reused, not invented
// ============================================================

check(
  html.includes('button {') && /button\s*\{[^}]*background:\s*#22c55e;/.test(html),
  'the existing primary-button green (#22c55e) is confirmed as this file\'s established accent — used already for buttons/status-title/checkout-banner'
);
check(
  html.includes('.option-card.selected,') &&
    /\.option-card\.selected,\s*\n\s*\.option-card:has\(input:checked\)\s*\{\s*\n\s*border-color:\s*#22c55e;/.test(html),
  'the new card selected-state reuses the file\'s existing #22c55e brand green (not an invented color) for the border'
);
check(
  /\.option-card\.selected \.option-card-check,\s*\n\s*\.option-card:has\(input:checked\) \.option-card-check\s*\{\s*\n\s*border-color:\s*#22c55e;\s*\n\s*background:\s*#22c55e;/.test(html),
  'the selected-state checkmark badge fills with the same #22c55e brand green — a very obvious, high-contrast selected indicator'
);

// ============================================================
// Whole-card tappability + generous, near-full-width mobile sizing
// ============================================================

check(
  /\.option-card\s*\{[^}]*min-height:\s*60px;/.test(html),
  'each option card has a large, touch-friendly minimum height (60px), not a small radio/checkbox'
);
check(
  /@media \(max-width: 480px\) \{\s*\n\s*\.option-cards \{\s*\n\s*max-width:\s*100%;/.test(html),
  'on phone widths, option cards expand to near-full-width (max-width overridden to 100%) rather than staying capped at the desktop width'
);

// ============================================================
// Device-type radio group (carrierDeviceType) — the pre-payment picker
// explicitly documented elsewhere in this file as mirroring
// mobile/app/(setup)/device-picker.tsx exactly.
// ============================================================

['carrierDeviceMobile', 'carrierDeviceLandline', 'carrierDeviceIphone'].forEach((id) => {
  const re = new RegExp(
    `<label class="option-card">\\s*\\n\\s*<input type="radio" name="carrierDeviceType" id="${id}" value="[a-z]+"[^>]*>`
  );
  check(re.test(html), `${id}'s radio input is unchanged (same id/name/value) and now sits inside a whole-card <label> — the entire card is tappable, not just the input`);
});
check(
  html.includes('id="carrierDeviceMobile" value="mobile" checked'),
  'Android/mobile stays the pre-selected default, exactly as before'
);
check(
  html.includes('<img src="/android-device-mark.png"') &&
    html.includes('<img src="/landline-device-mark.png"') &&
    html.includes('<img src="/iphone-device-mark.png"'),
  'device-type cards use the existing branded device-mark assets (public/android-device-mark.png etc. — the same files already used on the /go landing page) rather than inventing new icons'
);
['android-device-mark.png', 'landline-device-mark.png', 'iphone-device-mark.png'].forEach((f) => {
  check(existsSync(path.join(__dirname, '..', 'public', f)), `public/${f} actually exists on disk (not a dangling reference)`);
});
check(
  html.includes('iPhone — Coming soon'),
  'the iPhone option\'s "Coming soon" wording is preserved verbatim inside its card'
);

// ============================================================
// Select-backed groups (network / tariff / landline provider /
// post-payment device type / post-payment landline provider) — the
// native <select> stays the single source of truth for .value, now
// visually hidden; cards are generated from its real <option> list.
// ============================================================

function selectBlock(id) {
  const re = new RegExp(`<select id="${id}"[^>]*>[\\s\\S]*?</select>`);
  const m = html.match(re);
  return m ? m[0] : '';
}

[
  { id: 'carrierNetworkSelect', options: ['ee', 'o2', 'vodafone', 'three', 'giffgaff', 'tesco', 'sky', 'id_mobile', 'smarty', 'voxi', 'lebara', 'lyca', 'talkmobile', 'asda', '1pmobile', 'other'] },
  { id: 'carrierTariffSelect', options: ['pay_monthly', 'payg'] },
  { id: 'carrierLandlineProviderSelect', options: ['bt', 'sky', 'virgin', 'talktalk', 'plusnet', 'other'] },
  { id: 'deviceTypeSelect', options: ['iphone', 'android', 'landline'] },
  { id: 'landlineProviderSelect', options: ['bt', 'sky', 'virgin', 'talktalk', 'plusnet', 'other'] },
].forEach(({ id, options }) => {
  const block = selectBlock(id);
  check(block.length > 0, `${id} still exists in the markup`);
  check(
    block.includes('class="visually-hidden"') && block.includes('aria-hidden="true"') && block.includes('tabindex="-1"'),
    `${id} is visually hidden (cards are the visible/interactive UI) but stays in the DOM as the real value-carrying element`
  );
  options.forEach((value) => {
    check(block.includes(`value="${value}"`), `${id} still has its original option value="${value}" — eligibility/gate logic keyed to this value is unaffected`);
  });
});

// Exact original label wording for the two option sets that could easily
// be confused/merged (pre-payment vs post-payment landline provider
// lists use deliberately different "other" wording).
check(html.includes('value="other">Other / Not sure<'), 'carrierNetworkSelect keeps its exact "Other / Not sure" wording');
check(html.includes('value="other">Not sure / another provider<'), 'carrierLandlineProviderSelect (pre-payment) keeps its exact "Not sure / another provider" wording');
check(html.includes('value="other">Other<'), 'landlineProviderSelect (post-payment activation form) keeps its own, separately-worded "Other" option — the two landline-provider lists were not merged into one');

// Each select-backed group has a matching cards container in the markup.
['carrierNetworkCards', 'carrierTariffCards', 'carrierLandlineProviderCards', 'deviceTypeCards', 'landlineProviderCards'].forEach((id) => {
  check(html.includes(`id="${id}"`) && html.includes(`role="radiogroup"`), `#${id} cards container exists in the markup as an accessible radiogroup`);
});

// ============================================================
// buildOptionCards: the generic select->cards renderer, and that it is
// actually wired up for every select-backed group (not just defined).
// ============================================================

const scriptStart = html.indexOf('<script>');
const script = html.slice(scriptStart);

check(script.includes('function buildOptionCards(select, container, optIconMap)'), 'the generic buildOptionCards(select, container, optIconMap) renderer is defined once and reused for every select-backed group');
check(
  script.includes('if (!option.value || option.hidden) return;'),
  'buildOptionCards skips both the blank placeholder option and any option a caller has hidden — e.g. the "already ruled out by a remembered answer" landline option — keeping cards in sync with select state'
);
check(
  script.includes('select.value = option.value;') && script.includes('select.dispatchEvent(new Event("change"));'),
  'clicking a generated card sets the real select\'s value and fires a native change event, so every existing change-listener keeps working unmodified'
);

[
  'buildOptionCards(carrierNetworkSelectEl, document.getElementById("carrierNetworkCards"));',
  'buildOptionCards(carrierTariffSelectEl, document.getElementById("carrierTariffCards"));',
  'buildOptionCards(carrierLandlineProviderSelectEl, document.getElementById("carrierLandlineProviderCards"));',
  'buildOptionCards(deviceTypeSelectEl, document.getElementById("deviceTypeCards"), DEVICE_TYPE_ICON_MAP);',
  'buildOptionCards(landlineProviderSelectEl, document.getElementById("landlineProviderCards"));',
].forEach((call) => {
  check(script.includes(call), `${call.split('(')[1].split(',')[0]} is actually wired up to render cards on load`);
});

// The post-payment device-type cards must be rebuilt (not just built
// once at load) whenever the remembered-answer logic changes which
// options are visible/selected — otherwise the visible cards would go
// stale against the real (hidden) <select>.
const rememberedFnStart = script.indexOf('function applyRememberedDeviceToManualForm');
const rememberedFnEnd = script.indexOf('\n  }\n', rememberedFnStart);
const rememberedFn = script.slice(rememberedFnStart, rememberedFnEnd);
check(
  rememberedFn.includes('buildOptionCards(deviceTypeSelectEl, document.getElementById("deviceTypeCards"), DEVICE_TYPE_ICON_MAP);'),
  'applyRememberedDeviceToManualForm rebuilds the device-type cards after hiding the already-ruled-out landline option, so the visible cards never show a stale/impossible choice'
);
const changeButtonStart = script.indexOf('deviceTypeChangeButtonEl.addEventListener("click"');
const changeButtonEnd = script.indexOf('\n    });\n', changeButtonStart);
const changeButtonHandler = script.slice(changeButtonStart, changeButtonEnd);
check(
  changeButtonHandler.includes('buildOptionCards(deviceTypeSelectEl, document.getElementById("deviceTypeCards"), DEVICE_TYPE_ICON_MAP);'),
  '"Change" button handler rebuilds the device-type cards after restoring the landline option and clearing the value, so the reset is reflected visually'
);

// ============================================================
// No eligibility/gate logic was touched by this presentation change —
// re-affirm the same invariants the existing carrier-gate test already
// covers, scoped to what this change could plausibly have disturbed.
// ============================================================

check(
  script.includes('const isMobile = carrierDeviceMobileEl && carrierDeviceMobileEl.checked;') &&
    script.includes('const isLandline = carrierDeviceLandlineEl && carrierDeviceLandlineEl.checked;'),
  'device-type change handling still reads .checked directly off the real radio inputs, unaffected by the new card wrapper markup'
);
check(
  script.includes('const provider = carrierNetworkSelectEl ? carrierNetworkSelectEl.value : "";') &&
    script.includes('const landlineProvider = carrierLandlineProviderSelectEl ? carrierLandlineProviderSelectEl.value : "";'),
  'submit-time reads still pull from the real (now visually hidden) <select> elements\' .value, unaffected by the new cards'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
