#!/usr/bin/env node
// Milestone-1 proof script (docs/operations/HANDOVER_2026-08-15.md §18.6
// step 4): places a real call directly to a registered Voice SDK Client
// identity, completely independent of the existing /voice -> /process
// screening flow. This is the cleanest isolated way to prove "does the
// app ring on the physical device and connect two-way audio" without
// needing a real forwarded PSTN call, carrier involvement, or any
// screening logic to also be correct at the same time.
//
// Prerequisites (all from docs/operations/HANDOVER_2026-08-15.md §18.4):
//   - The app must already be running on a real physical device (not a
//     simulator -- the Voice SDK does not work on iOS simulators) and
//     have successfully called registerForIncomingCalls()
//     (mobile/lib/voiceClient.ts) -- check the device logs for "Voice
//     SDK: registered for incoming calls" before running this.
//   - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and a real Twilio number
//     this account owns, all in .env.
//
// Usage:
//   node scripts/trigger-voice-sdk-test-call.js <householdId> <fromTwilioNumber>
//
// Example:
//   node scripts/trigger-voice-sdk-test-call.js f8719395-90b5-4589-9488-a68888464221 +441322946885

require('dotenv').config();
const twilio = require('twilio');
const { buildVoiceClientIdentity } = require('../services/voiceAccessToken');

async function main() {
  const [householdId, fromNumber] = process.argv.slice(2);

  if (!householdId || !fromNumber) {
    console.error('Usage: node scripts/trigger-voice-sdk-test-call.js <householdId> <fromTwilioNumber>');
    process.exitCode = 1;
    return;
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const appUrl = process.env.APP_URL || 'https://www.homecallguard.co.uk';

  if (!accountSid || !authToken) {
    console.error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set in .env');
    process.exitCode = 1;
    return;
  }

  const client = twilio(accountSid, authToken);
  const identity = buildVoiceClientIdentity(householdId);

  console.log(`Placing a test call to client:${identity} ...`);

  const call = await client.calls.create({
    to: `client:${identity}`,
    from: fromNumber,
    // Fetched once the client answers -- this is what plays down the
    // line to prove two-way audio, not what decides routing (routing is
    // already decided by `to: client:...` above).
    url: `${appUrl}/voice-sdk-test-call-answered`,
  });

  console.log('Call initiated:', call.sid);
  console.log('Watch the physical device now -- it should ring within a few seconds.');
  console.log('Check status with: node -e "require(\'dotenv\').config(); require(\'twilio\')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN).calls(\'' + call.sid + '\').fetch().then(c => console.log(c.status))"');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
});
