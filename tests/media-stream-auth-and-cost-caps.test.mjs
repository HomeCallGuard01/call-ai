// P0 remediation (2026-10-01): /media-stream authorisation and hard cost
// caps, at handler level with fake transcription and SMS clients (no paid
// AI, no real SMS).
// Run with: node tests/media-stream-auth-and-cost-caps.test.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createMediaStreamHandler } = require('../services/liveMonitoring/mediaStreamHandler.js');
const { createStreamAuthRegistry } = require('../services/liveMonitoring/streamAuth.js');
const { createCostCaps } = require('../services/liveMonitoring/costCaps.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOUD = Buffer.alloc(160, 0x80).toString('base64');
const QUIET = Buffer.alloc(160, 0xff).toString('base64');
const start = (sid, callSid, customParameters) => JSON.stringify({ event: 'start', streamSid: sid, start: { streamSid: sid, callSid, customParameters } });
async function speak(h, sid, seconds = 5) {
  for (let i = 0; i < seconds * 50; i++) await h.handleMessage(JSON.stringify({ event: 'media', streamSid: sid, media: { payload: LOUD } }));
  for (let i = 0; i < 60; i++) await h.handleMessage(JSON.stringify({ event: 'media', streamSid: sid, media: { payload: QUIET } }));
  await sleep(20);
}

function rig({ authorizeStream, costCaps, transcript = 'please read me the code from the text we just sent you, do not tell anyone' } = {}) {
  const transcriptions = []; const sms = []; let closed = 0;
  const h = createMediaStreamHandler({
    transcribeClient: { transcribe: async () => { transcriptions.push(1); return transcript; } },
    smsClient: { messages: { create: async (p) => { sms.push(p); return { sid: 'SMfake' }; } } },
    fromNumber: '+441615550199',
    sendAlert: async () => true,
    recordOutcome: async () => {},
    ...(authorizeStream ? { authorizeStream } : {}),
    ...(costCaps ? { costCaps } : {}),
  });
  return { h, transcriptions, sms, closeConnection: () => { closed++; }, closed: () => closed };
}

// 1. No authoriser configured → fail closed.
{
  const r = rig();
  await r.h.handleMessage(start('MZ1', 'CA1', { householdId: 'hh', toNumber: '+447700900999', protectedNumber: '+441615550100' }), { closeConnection: r.closeConnection });
  await speak(r.h, 'MZ1');
  check(r.closed() === 1 && r.transcriptions.length === 0 && r.sms.length === 0, 'with no authoriser configured every stream is refused (fail closed): no transcription, no SMS');
}

// 2. Real registry: forged parameters are ignored; destination comes from the signed /voice record.
{
  const reg = createStreamAuthRegistry();
  const token = reg.issue({ callSid: 'CA2', householdId: 'hh2', toNumber: '+447700900123', fromNumber: '+441615550100' });
  const r = rig({ authorizeStream: reg.authorize });
  await r.h.handleMessage(start('MZ2', 'CA2', { streamToken: token, householdId: 'attacker-hh', toNumber: '+447700900999', protectedNumber: '+441615559999' }), { closeConnection: r.closeConnection });
  await speak(r.h, 'MZ2', 8);
  await sleep(50);
  check(r.transcriptions.length > 0, 'an authorised stream is transcribed');
  check(r.sms.length >= 1 && r.sms.every((m) => m.to === '+447700900123' && m.from === '+441615550100'), 'warning SMS go only to the server-side destination, from the household\'s own number, never to stream-supplied numbers');
}

// 3. Token rules.
{
  const reg = createStreamAuthRegistry({ ttlMs: 50 });
  const t1 = reg.issue({ callSid: 'CA3', householdId: 'hh3' });
  check(reg.authorize({ callSid: 'CAother', streamToken: t1 }) === null, 'a token is rejected for a different CallSid');
  check(reg.authorize({ callSid: 'CA3', streamToken: t1 })?.householdId === 'hh3', 'the token is accepted for its own CallSid');
  check(reg.authorize({ callSid: 'CA3', streamToken: t1 }) === null, 'a token is single-use (replay rejected)');
  const t2 = reg.issue({ callSid: 'CA4', householdId: 'hh4' });
  await sleep(80);
  check(reg.authorize({ callSid: 'CA4', streamToken: t2 }) === null, 'an expired token is rejected');
  check(reg.issue({ callSid: null, householdId: 'x' }) === null && reg.authorize({ callSid: 'CA', streamToken: '' }) === null, 'no token without a CallSid; empty tokens rejected');
  check(t1.length >= 43, 'tokens carry 256 bits of randomness');
}

// 4. Per-household concurrent streams.
{
  const reg = createStreamAuthRegistry();
  const r = rig({ authorizeStream: reg.authorize });
  for (const i of [1, 2, 3]) {
    const t = reg.issue({ callSid: `CA5${i}`, householdId: 'hh5', toNumber: '+447700900123', fromNumber: '+441615550100' });
    await r.h.handleMessage(start(`MZ5${i}`, `CA5${i}`, { streamToken: t }), { closeConnection: r.closeConnection });
  }
  check(r.closed() === 1, 'a third simultaneous stream for one household is refused (cap 2)');
  await r.h.handleMessage(JSON.stringify({ event: 'stop', streamSid: 'MZ51', stop: {} }));
  await sleep(20);
  const t4 = reg.issue({ callSid: 'CA54', householdId: 'hh5' });
  await r.h.handleMessage(start('MZ54', 'CA54', { streamToken: t4 }), { closeConnection: r.closeConnection });
  check(r.closed() === 1, 'ending a stream frees the household slot');
}

// 5. Transcription and SMS caps (tight limits to exercise them).
{
  const caps = createCostCaps({ maxStreamsPerHousehold: 5, maxTranscriptionsPerHouseholdPerDay: 2, maxTranscriptionsPerHour: 100, maxSmsPerHouseholdPerDay: 1, maxSmsPerHour: 100 });
  check(caps.allowTranscription('h') && caps.allowTranscription('h') && !caps.allowTranscription('h'), 'transcriptions stop at the per-household daily cap');
  check(caps.allowTranscription('other'), 'one household hitting its cap does not affect another');
  check(caps.allowSms('h', { to: '+447700900123', from: '+441615550100' }) && !caps.allowSms('h', { to: '+447700900123', from: '+441615550100' }), 'SMS stop at the per-household daily cap');
  check(!caps.allowSms('x', { to: '+12025550100', from: '+441615550100' }), 'SMS to a non-UK destination are refused');
  check(!caps.allowSms('x', { to: '+441615550100', from: '+441615550100' }) && !caps.allowSms('x', { to: '+449090000000', from: '+441615550100' }), 'SMS to a landline/premium-style or self number are refused (UK mobiles only)');
  const g = createCostCaps({ maxStreamsPerHousehold: 5, maxTranscriptionsPerHouseholdPerDay: 1000, maxTranscriptionsPerHour: 3, maxSmsPerHouseholdPerDay: 10, maxSmsPerHour: 2 });
  check(g.allowTranscription('a') && g.allowTranscription('b') && g.allowTranscription('c') && !g.allowTranscription('d'), 'the global hourly transcription ceiling applies across households');
  check(g.allowSms('a', { to: '+447700900001', from: '+441615550100' }) && g.allowSms('b', { to: '+447700900002', from: '+441615550100' }) && !g.allowSms('c', { to: '+447700900003', from: '+441615550100' }), 'the global hourly SMS ceiling applies across households');
}

// 6. Handler honours the transcription cap end to end.
{
  const reg = createStreamAuthRegistry();
  const caps = createCostCaps({ maxStreamsPerHousehold: 2, maxTranscriptionsPerHouseholdPerDay: 1, maxTranscriptionsPerHour: 100, maxSmsPerHouseholdPerDay: 3, maxSmsPerHour: 30 });
  const r = rig({ authorizeStream: reg.authorize, costCaps: caps, transcript: 'hello' });
  const t = reg.issue({ callSid: 'CA6', householdId: 'hh6' });
  await r.h.handleMessage(start('MZ6', 'CA6', { streamToken: t }), { closeConnection: r.closeConnection });
  await speak(r.h, 'MZ6', 5); await speak(r.h, 'MZ6', 5); await speak(r.h, 'MZ6', 5);
  check(r.transcriptions.length === 1, `the handler stops paid transcription at the cap (made ${r.transcriptions.length})`);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
