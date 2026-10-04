// Xero Accounting API adapter (HTTP). DISABLED unless explicitly enabled and
// configured — there are no Xero credentials anywhere in HCG today, and this
// module never invents them. With no configuration every call throws
// XeroError('unavailable') and the posting queue simply keeps work queued.
//
// Intended connection: a Xero "custom connection" (machine-to-machine,
// OAuth 2.0 client-credentials, one organisation; a paid Xero add-on) —
// see docs/finance/ACCOUNTING_AUTOMATION.md §7. Scopes are configuration
// (XERO_SCOPES) because Xero has been moving to granular scopes; verify the
// exact names in the Xero developer portal when the connection is created.
//
// Env: ACCOUNTING_XERO_POSTING_ENABLED=true, XERO_CLIENT_ID, XERO_CLIENT_SECRET,
//      XERO_SCOPES, optional XERO_TENANT_ID.
// fetch is injected (tests never touch the network).

'use strict';

const { XeroError, classifyHttpStatus } = require('./errors');
const { ID_FIELD } = require('./mockXero');

const TOKEN_URL = 'https://identity.xero.com/connect/token';
const API_BASE = 'https://api.xero.com/api.xro/2.0';

function loadXeroConfig(env = process.env) {
  return {
    enabled: env.ACCOUNTING_XERO_POSTING_ENABLED === 'true',
    clientId: env.XERO_CLIENT_ID || null,
    clientSecret: env.XERO_CLIENT_SECRET || null,
    tenantId: env.XERO_TENANT_ID || null,
    scopes: env.XERO_SCOPES || null,
  };
}

function xeroConnectionStatus(config) {
  if (!config.enabled) return { connected: false, reason: 'posting_disabled (ACCOUNTING_XERO_POSTING_ENABLED is not "true")' };
  if (!config.clientId || !config.clientSecret || !config.scopes) return { connected: false, reason: 'credentials_not_configured' };
  return { connected: null, reason: 'configured_not_verified' };
}

function createXeroHttpClient({ config, fetchImpl, now = () => Date.now() }) {
  const status = xeroConnectionStatus(config);
  let token = null; // { value, expiresAt }

  async function accessToken() {
    if (status.connected === false) throw new XeroError('unavailable', status.reason);
    if (typeof fetchImpl !== 'function') throw new XeroError('unavailable', 'no fetch implementation injected');
    if (token && token.expiresAt - 60_000 > now()) return token.value;
    let res;
    try {
      res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: config.scopes }).toString(),
      });
    } catch (err) {
      throw new XeroError('unavailable', `token request failed: ${err.message}`);
    }
    if (!res.ok) throw new XeroError('unavailable', `token request HTTP ${res.status}`, { status: res.status });
    const json = await res.json();
    token = { value: json.access_token, expiresAt: now() + (Number(json.expires_in) || 1800) * 1000 };
    return token.value;
  }

  async function call(method, url, { body, idempotencyKey } = {}) {
    const headers = { Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json' };
    if (config.tenantId) headers['xero-tenant-id'] = config.tenantId;
    if (body) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (err) {
      throw new XeroError('unknown_outcome', `network error: ${err.message}`);
    }
    if (!res.ok) {
      const errorClass = classifyHttpStatus(res.status);
      const retryAfter = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('retry-after')) || null : null;
      if (errorClass === 'unavailable') token = null;
      throw new XeroError(errorClass, `Xero HTTP ${res.status}`, { status: res.status, retryAfterSeconds: retryAfter });
    }
    return res.json();
  }

  return {
    status,
    async createDocument({ endpoint, body, idempotencyKey }) {
      const idField = ID_FIELD[endpoint];
      if (!idField) throw new XeroError('rejected', `unsupported endpoint ${endpoint}`);
      // PUT = create only (POST would create-or-update).
      const json = await call('PUT', `${API_BASE}/${endpoint}`, { body: { [endpoint]: [body] }, idempotencyKey });
      const doc = json && Array.isArray(json[endpoint]) ? json[endpoint][0] : null;
      if (!doc || !doc[idField]) throw new XeroError('unknown_outcome', 'Xero response had no document id');
      return { id: doc[idField] };
    },
    async findByReference({ endpoint, reference }) {
      const idField = ID_FIELD[endpoint];
      const where = `Reference=="${String(reference).replace(/"/g, '\\"')}"`;
      const json = await call('GET', `${API_BASE}/${endpoint}?where=${encodeURIComponent(where)}`);
      const doc = json && Array.isArray(json[endpoint]) ? json[endpoint].find((d) => d.Reference === reference && d.Status !== 'DELETED' && d.Status !== 'VOIDED') : null;
      return doc ? { id: doc[idField] } : null;
    },
  };
}

module.exports = { createXeroHttpClient, loadXeroConfig, xeroConnectionStatus, TOKEN_URL, API_BASE };
