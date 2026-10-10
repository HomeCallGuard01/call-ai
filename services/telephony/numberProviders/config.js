'use strict';

// NUMBER_PROVIDER — where a new household's HCG number comes from
// (WS6 Magrathea → Twilio BYOC, 2026-10-11).
//
//   unset / 'twilio'  (default) buy a Twilio-hosted number — unchanged.
//   'magrathea'       assign a Magrathea DDI from the manually maintained
//                     inventory (migration 078); never buys, never calls
//                     Magrathea. The DDI must already be routed (by a human)
//                     to the Twilio BYOC trunk whose VoiceUrl is /voice.
//
// Any other value is INVALID and provisioning is HELD (fail closed — never a
// silent fallback to buying a Twilio number).

const NUMBER_PROVIDERS = Object.freeze(['twilio', 'magrathea']);
const INVENTORY_PROVIDERS = Object.freeze(['magrathea']);
const DEFAULT_INVENTORY_COOLING_OFF_DAYS = 30;

/** @returns {{ provider: string|null, valid: boolean, inventory: boolean, problem: string|null }} */
function resolveNumberProvider(env = process.env) {
  const raw = typeof env.NUMBER_PROVIDER === 'string' ? env.NUMBER_PROVIDER.trim().toLowerCase() : '';
  if (!raw) return { provider: 'twilio', valid: true, inventory: false, problem: null };
  if (!NUMBER_PROVIDERS.includes(raw)) return { provider: null, valid: false, inventory: false, problem: 'unknown_number_provider' };
  return { provider: raw, valid: true, inventory: INVENTORY_PROVIDERS.includes(raw), problem: null };
}

function inventoryCoolingOffDays(env = process.env) {
  const n = Number.parseInt(String(env.NUMBER_INVENTORY_COOLING_OFF_DAYS || ''), 10);
  return Number.isInteger(n) && n >= 0 && n <= 365 ? n : DEFAULT_INVENTORY_COOLING_OFF_DAYS;
}

module.exports = { NUMBER_PROVIDERS, INVENTORY_PROVIDERS, DEFAULT_INVENTORY_COOLING_OFF_DAYS, resolveNumberProvider, inventoryCoolingOffDays };
