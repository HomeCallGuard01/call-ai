// Email sender adapter for operational events (launch sprint 2026-10-05).
// Resend, the provider already used for critical alerts (services/alerting.js).
//
// Contract (services/opsEvents/runner.js deliverDueOpsEvents):
//   send({ to, subject, text, idempotencyKey }) →
//     { disabled: true }  channel off / no API key (delivery recorded 'disabled')
//     { sent: true, id }  provider accepted it
//     throws              anything else → the runner retries with backoff,
//                         then marks the delivery 'failed' (visible in admin)
//
// Idempotency: the delivery's key is sent as Resend's `Idempotency-Key`
// header, so a retry after a timeout (sent but the response was lost) cannot
// send a second email. Nothing here is on any entitlement, call or
// provisioning path, so a failure can never affect a customer.
'use strict';

const https = require('https');

const DEFAULT_FROM = 'Home Call Guard Operations <alerts@mail.homecallguard.co.uk>';

function httpsPostJson({ hostname, path, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * @param {{ env?: object, post?: Function, timeoutMs?: number }} [opts]
 *   post — injectable transport for tests: ({hostname,path,headers,body,timeoutMs}) → {status, body}
 */
function createResendOpsSender({ env = process.env, post = httpsPostJson, timeoutMs = 8000 } = {}) {
  return {
    async send({ to, subject, text, idempotencyKey }) {
      if (env.OPS_NOTIFY_EMAIL_ENABLED !== 'true') return { disabled: true };
      const apiKey = env.Resend_API_Key;
      if (!apiKey) return { disabled: true };
      if (!to || !subject || !idempotencyKey) throw new Error('ops email: missing recipient, subject or idempotency key');
      const body = JSON.stringify({ from: env.OPS_NOTIFY_FROM_EMAIL || DEFAULT_FROM, to: [to], subject, text });
      const res = await post({
        hostname: 'api.resend.com',
        path: '/emails',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': String(idempotencyKey).slice(0, 256) },
        body,
        timeoutMs,
      });
      if (res.status >= 200 && res.status < 300) {
        let id = null;
        try { id = JSON.parse(res.body).id || null; } catch { /* body optional */ }
        return { sent: true, id };
      }
      // Never include the API key or the full body; status is enough to retry/diagnose.
      throw new Error(`ops email: provider returned HTTP ${res.status}`);
    },
  };
}

module.exports = { createResendOpsSender, DEFAULT_FROM };
