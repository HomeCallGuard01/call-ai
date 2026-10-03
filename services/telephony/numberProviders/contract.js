// Provider-neutral number operations — the contract every carrier adapter
// implements. Only the operations HCG actually performs today are here
// (see services/twilioProvisioning.js and services/twilioNumberReleaseRunner.js);
// nothing speculative about any future carrier's API.
//
//   provisionNumber({ country, inboundCallUrl, addressId, bundleId })
//       -> { resourceId, e164 }       search + buy one voice-capable number
//   getNumberConfiguration(resourceId)
//       -> { resourceId, e164, inboundCallUrl, inboundCallMethod }
//   configureInboundRoute(resourceId, { inboundCallUrl, inboundCallMethod })
//       -> same shape as getNumberConfiguration
//   findResourceId(e164)
//       -> resourceId | null          handle for a number HCG already owns
//   fetchNumberStatus(resourceId)
//       -> { resourceId, exists, e164 }
//   releaseNumber(resourceId)
//       -> { released: true }
//
// and a static `capabilities` object. A capability that HCG has not
// verified for a provider is `null` (unknown), never assumed `true`.
//
// "resourceId" is the provider's own handle (Twilio: IncomingPhoneNumber
// SID). It is stored in routing_assignments.provider_resource_id and is
// opaque everywhere outside the adapter. The same vocabulary as
// architecture/voice-provider-portability's numberProvider seam
// (id / inboundCallUrl / addressId / bundleId) so the two can be merged.

'use strict';

const REQUIRED_METHODS = Object.freeze([
  'provisionNumber',
  'getNumberConfiguration',
  'configureInboundRoute',
  'findResourceId',
  'fetchNumberStatus',
  'releaseNumber',
]);

const CAPABILITY_KEYS = Object.freeze([
  'numberPurchase',
  'inboundVoiceWebhook',
  'configureInboundRoute',
  'numberRelease',
  'portIn',
  'portOut',
]);

function assertNumberProviderAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('number provider adapter must be an object');
  if (typeof adapter.code !== 'string' || !/^[a-z][a-z0-9_]{1,31}$/.test(adapter.code)) {
    throw new Error('number provider adapter needs a lowercase code matching telephony_providers.code');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new Error(`number provider adapter "${adapter.code}" is missing ${method}()`);
    }
  }
  const caps = adapter.capabilities || {};
  for (const key of CAPABILITY_KEYS) {
    if (!(key in caps) || ![true, false, null].includes(caps[key])) {
      throw new Error(`number provider adapter "${adapter.code}" must declare capability ${key} as true, false or null`);
    }
  }
  return adapter;
}

module.exports = { REQUIRED_METHODS, CAPABILITY_KEYS, assertNumberProviderAdapter };
