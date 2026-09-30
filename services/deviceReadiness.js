'use strict';

// Device call-readiness payload (2026-09-30, release readiness). Parses the
// optional `readiness` object the app sends so only enumerated values are
// ever stored. Pure.
//
//   { platform: 'android'|'ios', microphone, notifications, osVersion }
//   microphone/notifications: 'granted' | 'denied' | 'not_required' | 'unknown'

const PLATFORMS = new Set(['android', 'ios']);
const STATES = new Set(['granted', 'denied', 'not_required', 'unknown']);
const TRIGGERS = new Set(['registration', 'foreground', 'sdk_error']);

function parseDeviceReadiness(raw, { trigger = 'registration' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const platform = PLATFORMS.has(raw.platform) ? raw.platform : null;
  if (!platform) return null;
  const state = v => (STATES.has(v) ? v : 'unknown');
  const osVersion = Number.isInteger(raw.osVersion) && raw.osVersion >= 0 && raw.osVersion <= 100 ? raw.osVersion : undefined;
  const out = {
    platform,
    microphone: state(raw.microphone),
    notifications: state(raw.notifications),
    trigger: TRIGGERS.has(trigger) ? trigger : 'registration',
  };
  if (osVersion !== undefined) out.osVersion = osVersion;
  return out;
}

// True when the reported state means the phone cannot present a call.
function isDeviceNotReady(readiness) {
  return Boolean(readiness) && (readiness.microphone === 'denied' || readiness.notifications === 'denied');
}

module.exports = { parseDeviceReadiness, isDeviceNotReady };
