// byocWebhooks.mjs — webhook shapes for an INBOUND Magrathea → Twilio BYOC
// call, as Twilio presents it to HCG (WS7, 2026-10-11).
//
// Source of the shape: research/business-decision-2026-10-10
//   docs/research/2026-10-10-business-decision/MAGRATHEA-TWILIO-BYOC-INVESTIGATION.md
// and the Magrathea trial evidence (LIVE CALLS 1–3, 2026-10-08):
//   * To      — the household's HCG number = the Magrathea DDI, E.164
//               (+44…). Twilio renders BYOC To from the Request-URI user;
//               Magrathea sends it WITHOUT the plus (443300884327), so a
//               missing-plus variant is also exercised (WS6 contract).
//   * From    — the caller as Magrathea presents it: UK NATIONAL format
//               (07…) on the trial; +44… and 0044… are also exercised.
//   * Direction=inbound, CallerName ABSENT (no CNAM on BYOC).
//   * NO Diversion / X-* / ForwardedFrom: Twilio discards custom SIP
//               headers on BYOC (the investigation's key finding), so HCG
//               cannot see that the call was diverted from the customer's
//               mobile, nor the original called party.
//   * AccountSid — the (sub)account that owns the BYOC trunk; the request is
//               signed with THAT account's auth token.
// All numbers are synthetic: Ofcom drama ranges (07700 900xxx mobiles,
// 0306 999 0xxx for the 03 DDIs, 0161 496 0xxx geographic).

export const BYOC_HEADERS_ABSENT = Object.freeze(['CallerName', 'ForwardedFrom', 'Diversion', 'SipHeader_Diversion', 'SipHeader_X-Original-To']);

let seq = 0;
/** Unique, well-formed CallSid (CA + 32 hex). */
export function newCallSid() {
  seq += 1;
  const rand = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  return `CA${seq.toString(16).padStart(8, '0')}${rand}${'b0c0'.repeat(4)}`;
}

/** UK caller presentations of one E.164 mobile. */
export function callerVariants(e164) {
  const nsn = e164.replace(/^\+44/, '');
  return { national: `0${nsn}`, e164, idd00: `0044${nsn}` };
}

/** /voice params for one inbound BYOC call. */
export function byocVoiceParams({ to, from, accountSid, callSid = newCallSid(), extra = {} }) {
  const p = {
    AccountSid: accountSid,
    ApiVersion: '2010-04-01',
    CallSid: callSid,
    CallStatus: 'ringing',
    Direction: 'inbound',
    From: from,
    Caller: from,
    To: to,
    Called: to,
    // BYOC calls carry no geo lookups for a non-Twilio number; Twilio still
    // sends the keys, empty.
    FromCountry: '', FromCity: '', FromState: '', FromZip: '',
    ToCountry: '', ToCity: '', ToState: '', ToZip: '',
    ...extra,
  };
  for (const h of BYOC_HEADERS_ABSENT) delete p[h];
  return p;
}

/** /call-delivery-failed (the <Dial action>) for a BYOC call. */
export function byocDialActionParams({ callSid, to, from, accountSid, dialCallStatus = 'completed', duration = '5' }) {
  return {
    AccountSid: accountSid, ApiVersion: '2010-04-01', CallSid: callSid, CallStatus: 'in-progress', Direction: 'inbound',
    From: from, Caller: from, To: to, Called: to,
    DialCallSid: `CA${callSid.slice(2, 26)}dddddddd`,
    DialCallStatus: dialCallStatus,
    ...(dialCallStatus === 'completed' ? { DialCallDuration: duration } : {}),
  };
}

/** /call-status (statusCallback) for a BYOC call. */
export function byocCallStatusParams({ callSid, to, from, accountSid, callStatus = 'completed', duration = '5' }) {
  return {
    AccountSid: accountSid, ApiVersion: '2010-04-01', CallSid: callSid, CallStatus: callStatus, Direction: 'inbound',
    From: from, Caller: from, To: to, Called: to, CallDuration: duration, Duration: '1', Timestamp: new Date().toUTCString(),
  };
}
