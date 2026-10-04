'use strict';

// Telephony abuse P0 — composition root. server.js calls
// createTelephonyAbuseLayer() once at boot; everything else receives the
// pieces it needs. Every external dependency is a read (Supabase selects,
// Twilio REST list) — this layer never writes to the provider.

const { resolveAbuseConfig } = require('./abuseConfig');
const { createAbuseAudit } = require('./abuseAudit');
const { createVelocityStore } = require('./velocity');
const { createIncidentMode, ACTIONS } = require('./incidentMode');
const { createFinancialAuthorizationPort } = require('./financialAuthorizationPort');
const { createInboundCallGuard, createHoldStore, createAlertThrottle } = require('./inboundCallGuard');
const { createTwilioWebhookIntegrity } = require('./webhookIntegrity');
const { createTwimlEgressGuard } = require('./twimlEgressGuard');
const { createAccountRisk, normaliseEmailBase } = require('./accountRisk');
const { createProvisioningGuard } = require('./provisioningGuard');
const { canonicalKey } = require('./numberPolicy');

const DAY = 24 * 60 * 60 * 1000;

/** HCG-owned numbers (assigned + quarantined), cached; keeps the last good set on read failure. */
function createHcgNumberDirectory({ supabaseAdmin, refreshMs = 60 * 1000, now = () => Date.now() }) {
  let set = new Set();
  let loadedAt = 0;
  let loading = null;
  async function load() {
    if (!supabaseAdmin) return;
    const [hh, q] = await Promise.all([
      supabaseAdmin.from('households').select('twilio_number').not('twilio_number', 'is', null),
      supabaseAdmin.from('twilio_number_quarantine').select('twilio_number').is('released_at', null),
    ]);
    if (hh.error || q.error) throw new Error('hcg number directory read failed');
    const next = new Set();
    for (const r of [...(hh.data || []), ...(q.data || [])]) { const k = canonicalKey(r.twilio_number); if (k) next.add(k); }
    set = next;
    loadedAt = now();
  }
  return async function isHcgNumber(e164) {
    if (now() - loadedAt > refreshMs) {
      // On failure keep the last good set and retry in ~10s, so an outage
      // costs at most one slow lookup per 10s, not one per call.
      loading = loading || load().catch(() => { loadedAt = now() - refreshMs + 10 * 1000; }).finally(() => { loading = null; });
      await loading;
    }
    return set.has(canonicalKey(e164));
  };
}

function supabaseRiskSignals(supabaseAdmin) {
  if (!supabaseAdmin) return {};
  return {
    async countHouseholdsWithPhone(phone, excludeId) {
      const { data, error } = await supabaseAdmin.from('households').select('id').eq('phone_number', phone).neq('id', excludeId).limit(50);
      if (error) throw error;
      return (data || []).length;
    },
    async countHouseholdsWithEmailBase(base, excludeId) {
      const domain = base.split('@')[1];
      const domains = domain === 'gmail.com' ? ['gmail.com', 'googlemail.com'] : [domain];
      let n = 0;
      for (const d of domains) {
        const { data, error } = await supabaseAdmin.from('households').select('id,email').ilike('email', `%@${d}`).neq('id', excludeId).limit(5000);
        if (error) throw error;
        n += (data || []).filter((r) => normaliseEmailBase(r.email) === base).length;
      }
      return n;
    },
    async countRecentNumbersForHousehold(householdId) {
      const since = new Date(Date.now() - 30 * DAY).toISOString();
      const { data, error } = await supabaseAdmin.from('twilio_number_quarantine').select('id').eq('household_id', householdId).gte('quarantined_at', since).limit(50);
      if (error) throw error;
      return (data || []).length;
    },
    async entitlementSource(householdId) {
      const { data, error } = await supabaseAdmin.from('entitlements').select('entitlement_type,source').eq('household_id', householdId).eq('status', 'active').limit(1);
      if (error) throw error;
      const row = (data || [])[0];
      return row ? String(row.entitlement_type || row.source || '') : null;
    },
  };
}

function twilioLiveCallCounter(client) {
  if (!client || !client.calls || typeof client.calls.list !== 'function') return null;
  return async ({ to, from }) => {
    const base = { limit: 20, ...(to ? { to } : {}), ...(from ? { from } : {}) };
    const [ringing, inProgress] = await Promise.all([
      client.calls.list({ ...base, status: 'ringing' }),
      client.calls.list({ ...base, status: 'in-progress' }),
    ]);
    return (ringing || []).length + (inProgress || []).length;
  };
}

/**
 * @param {object} opts
 * @param {object} [opts.env]
 * @param {object|null} opts.supabaseAdmin
 * @param {object|null} opts.twilioRestClient
 * @param {(type, message, ctx) => Promise} opts.sendAlert
 * @param {string} opts.appUrl
 * @param {object|null} [opts.financialAuthorization]  Claude 1 { authorize, release }
 * @param {Function|null} [opts.financialBreaker]       Claude 1 breaker state reader
 * @param {Function|null} [opts.auditWriter]            persistent audit sink (provisional table)
 * @param {Function|null} [opts.isHcgNumber]            override (tests)
 * @param {Function|null} [opts.countLiveCalls]         override (tests)
 * @param {object} [opts.riskSignals]                   override (tests)
 */
function createTelephonyAbuseLayer(opts) {
  const env = opts.env || process.env;
  const config = resolveAbuseConfig(env);
  const audit = createAbuseAudit({ writer: opts.auditWriter || null });
  const velocity = createVelocityStore({ now: opts.now });
  const alert = createAlertThrottle(opts.sendAlert || (async () => {}));
  const incident = createIncidentMode({
    env,
    financialBreaker: opts.financialBreaker || null,
    onChange: (from, to) => {
      audit.record({ reasonCode: 'incident_level_changed', action: to === 'normal' ? 'allow_flagged' : 'hold', kind: 'incident', facts: { from, to }, severity: 'critical' });
      alert(`abuse_incident_${to}`, `Telephony abuse incident level changed ${from} → ${to}`, { from, to });
    },
  });
  const financial = createFinancialAuthorizationPort(opts.financialAuthorization || null, { timeoutMs: config.financialAuthTimeoutMs });
  const holds = createHoldStore({ env, readHold: opts.readHouseholdHold || null, writeHold: opts.writeHouseholdHold || null });
  const isHcgNumber = opts.isHcgNumber || createHcgNumberDirectory({ supabaseAdmin: opts.supabaseAdmin });
  const countLiveCalls = opts.countLiveCalls !== undefined ? opts.countLiveCalls : twilioLiveCallCounter(opts.twilioRestClient);

  const inboundGuard = createInboundCallGuard({ config, velocity, incident, audit, financial, holds, isHcgNumber, countLiveCalls, alert });
  const webhookIntegrity = createTwilioWebhookIntegrity({ config, audit });
  let ownHost = null;
  try { ownHost = new URL(opts.appUrl).host; } catch { ownHost = null; }
  const guardTwiml = createTwimlEgressGuard({ ownHost, audit });
  const signals = opts.riskSignals || supabaseRiskSignals(opts.supabaseAdmin);
  const accountRisk = createAccountRisk({ config, ...signals });
  const provisioningGuard = createProvisioningGuard({ config, incident, velocity, audit, accountRisk, alert, entitlementSource: signals.entitlementSource,
    // Integration 2026-10-04: buy → abandon → repeat is a FINANCIAL abuse
    // signal ⇒ automatic Fortress household hold (admin release only).
    onFraudHold: (householdId, reason) => holds.hold(householdId, reason, 'fraud') });

  /** For code that is not request-scoped: may a new paid action of `kind` start? */
  async function paidActionGate(kind, ctx = {}) {
    const action = { sms: ACTIONS.SMS, monitoring: ACTIONS.MONITORING, provision_number: ACTIONS.PROVISION_NUMBER }[kind];
    if (!action) return false;
    const r = await incident.check(action);
    if (!r.allowed) audit.record({ reasonCode: r.reason, action: 'suppress', kind, householdId: ctx.householdId || null, facts: { level: r.level }, severity: 'critical' });
    return r.allowed;
  }

  return { config, audit, velocity, incident, financial, holds, isHcgNumber, inboundGuard, webhookIntegrity, guardTwiml, accountRisk, provisioningGuard, paidActionGate };
}

module.exports = { createTelephonyAbuseLayer, createHcgNumberDirectory, supabaseRiskSignals, twilioLiveCallCounter };
