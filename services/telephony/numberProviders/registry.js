// Provider code -> adapter factory. Only providers HCG has actually
// integrated are registered; a code that exists as a telephony_providers
// row (e.g. a carrier under evaluation) but has no adapter here fails
// loudly rather than falling back to Twilio.

'use strict';

const { createTwilioNumberProviderAdapter } = require('./twilio');

const FACTORIES = Object.freeze({
  twilio: deps => createTwilioNumberProviderAdapter(deps.twilioClient),
});

class UnsupportedNumberProviderError extends Error {
  constructor(code) {
    super(`No number-provider adapter is implemented for "${code}"`);
    this.name = 'UnsupportedNumberProviderError';
    this.code = code;
  }
}

function listImplementedProviders() {
  return Object.keys(FACTORIES);
}

function getNumberProviderAdapter(code, deps = {}) {
  const factory = Object.prototype.hasOwnProperty.call(FACTORIES, code) ? FACTORIES[code] : null;
  if (!factory) throw new UnsupportedNumberProviderError(code);
  return factory(deps);
}

module.exports = { getNumberProviderAdapter, listImplementedProviders, UnsupportedNumberProviderError };
