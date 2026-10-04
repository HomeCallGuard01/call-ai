'use strict';

// Telephony abuse P0 — TwiML egress guard.
//
// The last thing every Twilio voice response passes through before it is
// sent. Whatever any route, refactor or future feature built, HCG must
// never hand Twilio an instruction that creates a chargeable leg to a
// destination outside the product's scope. Today that scope is exactly:
//   - <Dial timeLimit=1..14400><Client> to THIS household's own Voice SDK identity
//   - <Start><Stream> to HCG's own /media-stream
//   - <Say>, <Pause>, <Hangup>, <Reject>, and <Gather> with an own-host action
// Everything else — <Number>, <Sip>, <Sim>, <Conference>, <Queue>,
// <Enqueue>, <Refer>, <Pay>, <Record>, <Sms>/<Message>, <Connect>, a
// <Redirect>/action/callback URL on a foreign host, or a <Client> for a
// different household — is replaced with an unbilled <Reject/> and audited.
//
// Fail-closed by design: a false positive here costs one call (alerted);
// a false negative could cost an unbounded amount of international or
// premium-rate traffic.

const MAX_DIAL_TIME_LIMIT_SECONDS = 14400;
const REJECT_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>';

const FORBIDDEN_TAGS = ['Number', 'Sip', 'Sim', 'Conference', 'Queue', 'Enqueue', 'Refer', 'Pay', 'Record', 'Sms', 'Message', 'Connect', 'Siprec', 'Transcription', 'VirtualAgent', 'Application'];
const ALLOWED_TAGS = new Set(['Response', 'Say', 'Pause', 'Hangup', 'Reject', 'Dial', 'Client', 'Identity', 'Parameter', 'Start', 'Stream', 'Gather', 'Redirect', 'Play']);
const URL_ATTRS = ['action', 'url', 'statusCallback', 'recordingStatusCallback', 'waitUrl', 'transcribeCallback', 'partialResultCallback'];

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function urlIsOwn(value, ownHost) {
  const v = decodeXmlEntities(value).trim();
  if (v.startsWith('/') && !v.startsWith('//') && !v.includes('\\')) return true; // relative to the webhook host
  try {
    const u = new URL(v);
    return ['https:', 'wss:'].includes(u.protocol) && !!ownHost && u.host === ownHost && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * @param {string} xml  TwiML about to be sent
 * @param {object} ctx
 * @param {string} ctx.ownHost                 APP_URL host
 * @param {string|null} ctx.expectedClientIdentity  this household's identity, or null (no Client allowed)
 * @returns {{ok: boolean, violations: string[]}}
 */
function inspectTwiml(xml, { ownHost, expectedClientIdentity = null } = {}) {
  const violations = [];
  if (typeof xml !== 'string' || !xml.includes('<Response')) return { ok: false, violations: ['not_twiml'] };

  const tagRe = /<\s*([A-Za-z][\w:-]*)([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(xml))) {
    const tag = m[1];
    if (tag.startsWith('?')) continue;
    if (FORBIDDEN_TAGS.includes(tag)) violations.push(`forbidden_verb:${tag}`);
    else if (!ALLOWED_TAGS.has(tag)) violations.push(`unknown_verb:${tag}`);
    const attrs = m[2] || '';
    const attrRe = /([A-Za-z][\w:-]*)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(attrs))) {
      if (URL_ATTRS.includes(a[1]) && !urlIsOwn(a[2], ownHost)) violations.push(`foreign_url:${tag}.${a[1]}`);
    }
    // Soft-launch integration 2026-10-04 (containment T9): a <Dial> without a
    // provider-enforced timeLimit runs to Twilio's 4-hour default. Every Dial
    // HCG emits must carry 1..MAX_DIAL_TIME_LIMIT_SECONDS (067's max_call_seconds
    // ceiling); anything else is replaced with an unbilled <Reject/>.
    if (tag === 'Dial') {
      const tl = /\btimeLimit\s*=\s*"([^"]*)"/.exec(attrs);
      const n = tl ? Number(tl[1]) : NaN;
      if (!tl) violations.push('dial_without_time_limit');
      else if (!Number.isInteger(n) || n < 1 || n > MAX_DIAL_TIME_LIMIT_SECONDS) violations.push('dial_time_limit_out_of_range');
    }
    if (tag === 'Stream') {
      const url = /\burl\s*=\s*"([^"]*)"/.exec(attrs);
      if (!url) violations.push('stream_without_url');
      else {
        try {
          const u = new URL(decodeXmlEntities(url[1]));
          if (u.pathname !== '/media-stream') violations.push('stream_unexpected_path');
        } catch { violations.push('stream_url_invalid'); }
      }
    }
  }

  const redirects = xml.match(/<Redirect[^>]*>([^<]*)<\/Redirect>/g) || [];
  for (const r of redirects) {
    const body = r.replace(/<\/?Redirect[^>]*>/g, '');
    if (!urlIsOwn(body, ownHost)) violations.push('foreign_url:Redirect.body');
  }

  const clients = [...xml.matchAll(/<Client[^>]*>([\s\S]*?)<\/Client>/g)].map((c) => {
    const inner = c[1];
    const ident = /<Identity>([^<]*)<\/Identity>/.exec(inner);
    return decodeXmlEntities(ident ? ident[1] : inner.replace(/<[^>]+>[^<]*<\/[^>]+>/g, '')).trim();
  });
  for (const id of clients) {
    if (!expectedClientIdentity || id !== expectedClientIdentity) violations.push('client_identity_mismatch');
  }
  if (/<Client[^>]*\/>/.test(xml)) violations.push('client_identity_mismatch');

  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

function createTwimlEgressGuard({ ownHost, audit }) {
  return function guardTwiml(xml, { expectedClientIdentity = null, householdId = null, correlationId = null, route = '/voice' } = {}) {
    const verdict = inspectTwiml(xml, { ownHost, expectedClientIdentity });
    if (verdict.ok) return xml;
    audit.record({
      reasonCode: 'twiml_egress_violation',
      action: 'reject',
      kind: 'inbound_call',
      householdId,
      correlationId,
      severity: 'critical',
      facts: { route, violations: verdict.violations.join(',') },
    });
    return REJECT_TWIML;
  };
}

module.exports = { inspectTwiml, createTwimlEgressGuard, REJECT_TWIML, FORBIDDEN_TAGS, MAX_DIAL_TIME_LIMIT_SECONDS };
