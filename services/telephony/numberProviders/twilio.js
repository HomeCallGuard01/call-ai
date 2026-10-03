// Twilio implementation of the number-provider contract (./contract.js).
// The only file in this directory that knows Twilio's REST shape. Not yet
// wired into services/twilioProvisioning.js — that module keeps calling
// the Twilio client directly until the routing read path moves to
// routing_assignments (docs/architecture/CUSTOMER_IDENTITY_AND_CARRIER_ABSTRACTION.md).
//
// The client is injected, so tests use a fake and nothing here can reach
// Twilio unless a caller passes the real client deliberately.

'use strict';

const { assertNumberProviderAdapter } = require('./contract');

// What HCG has actually exercised against Twilio. Porting has never been
// done through HCG, so it is unknown (null), not assumed.
const TWILIO_CAPABILITIES = Object.freeze({
  numberPurchase: true,
  inboundVoiceWebhook: true,
  configureInboundRoute: true,
  numberRelease: true,
  portIn: null,
  portOut: null,
});

function toConfiguration(number) {
  return {
    resourceId: number.sid,
    e164: number.phoneNumber,
    inboundCallUrl: number.voiceUrl || null,
    inboundCallMethod: number.voiceMethod || null,
  };
}

function createTwilioNumberProviderAdapter(client) {
  if (!client) throw new Error('createTwilioNumberProviderAdapter: a Twilio client is required');

  return assertNumberProviderAdapter({
    code: 'twilio',
    capabilities: TWILIO_CAPABILITIES,

    async provisionNumber({ country = 'GB', inboundCallUrl, addressId, bundleId }) {
      if (!inboundCallUrl) throw new Error('provisionNumber: inboundCallUrl is required');
      const available = await client.availablePhoneNumbers(country).local.list({ limit: 1, voiceEnabled: true });
      const candidate = available && available[0];
      if (!candidate) throw new Error(`No available Twilio numbers for ${country}`);
      const purchased = await client.incomingPhoneNumbers.create({
        phoneNumber: candidate.phoneNumber,
        voiceUrl: inboundCallUrl,
        voiceMethod: 'POST',
        ...(addressId ? { addressSid: addressId } : {}),
        ...(bundleId ? { bundleSid: bundleId } : {}),
      });
      return { resourceId: purchased.sid, e164: purchased.phoneNumber };
    },

    async getNumberConfiguration(resourceId) {
      return toConfiguration(await client.incomingPhoneNumbers(resourceId).fetch());
    },

    async configureInboundRoute(resourceId, { inboundCallUrl, inboundCallMethod = 'POST' }) {
      if (!inboundCallUrl) throw new Error('configureInboundRoute: inboundCallUrl is required');
      const updated = await client.incomingPhoneNumbers(resourceId).update({
        voiceUrl: inboundCallUrl,
        voiceMethod: inboundCallMethod,
      });
      return toConfiguration(updated);
    },

    async findResourceId(e164) {
      const matches = await client.incomingPhoneNumbers.list({ phoneNumber: e164, limit: 1 });
      return (matches && matches[0] && matches[0].sid) || null;
    },

    async fetchNumberStatus(resourceId) {
      try {
        const number = await client.incomingPhoneNumbers(resourceId).fetch();
        return { resourceId, exists: true, e164: number.phoneNumber };
      } catch (err) {
        if (err && (err.status === 404 || err.code === 20404)) {
          return { resourceId, exists: false, e164: null };
        }
        throw err;
      }
    },

    async releaseNumber(resourceId) {
      await client.incomingPhoneNumbers(resourceId).remove();
      return { released: true };
    },
  });
}

module.exports = { createTwilioNumberProviderAdapter, TWILIO_CAPABILITIES };
