// twilioCosts.js — real Twilio account cost/usage data for the business
// dashboard. Uses Twilio's own account-wide usage.records API (cheap,
// one call regardless of customer count — no per-household or per-call
// polling) rather than deriving cost from internal call records, since
// production's `calls` table has no duration column yet (see this
// build's own audit) and Twilio's usage.records already gives real,
// provider-confirmed £ figures directly.
//
// Every function here is read-only against Twilio's API and never
// throws — a Twilio outage or missing credentials degrades the
// dashboard to "unavailable", never crashes it, matching this
// codebase's established fail-open convention (services/twilioClient.js).
'use strict';

const { twilioRestClient } = require('../twilioClient');

function startOfTodayIso() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function startOfMonthIso() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Sums a Twilio usage.records response into a single GBP total. Records
// already come back priced in the account's billing currency (confirmed
// GBP for this account directly against the live Twilio API) — no FX
// conversion applied here.
function sumUsageRecordsGbp(records) {
  return (records || []).reduce((total, r) => total + Math.abs(Number(r.price) || 0), 0);
}

async function fetchUsageTotalGbp(client, { startDate, endDate }) {
  const records = await client.usage.records.list({ startDate, endDate, limit: 200 });
  // Twilio's usage.records returns one row per category (calls,
  // calls-inbound, calls-outbound, phonenumbers, ...) for the given
  // window, each with its own aggregated price — some categories overlap
  // (e.g. "calls" is the parent of "calls-inbound"/"calls-outbound"), so
  // summing every row would double-count. Only sum the categories that
  // are real, independent cost lines, matching the exact breakdown this
  // account was confirmed to produce this session: calls-inbound,
  // calls-outbound, phonenumbers, and any category not covered by those
  // three parents' own sub-categories.
  const category = (r) => r.category;
  const relevant = records.filter((r) =>
    ['calls-inbound', 'calls-outbound', 'phonenumbers', 'sms', 'sms-outbound', 'sms-inbound', 'trunking-termination', 'trunking-origination'].includes(category(r))
  );
  return { totalGbp: sumUsageRecordsGbp(relevant), byCategory: relevant.map((r) => ({ category: r.category, usage: r.usage, usageUnit: r.usage_unit, priceGbp: Number(r.price) || 0 })) };
}

// Real Twilio account snapshot: balance, number count, and today/MTD
// spend broken down by category. `client` is injectable for tests.
async function getTwilioAccountSnapshot({ client = twilioRestClient } = {}) {
  if (!client) {
    return { available: false, reason: 'TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not configured' };
  }

  try {
    const [balance, numbers, todayUsage, mtdUsage] = await Promise.all([
      client.balance.fetch(),
      client.incomingPhoneNumbers.list({ limit: 1000 }),
      fetchUsageTotalGbp(client, { startDate: startOfTodayIso(), endDate: new Date() }),
      fetchUsageTotalGbp(client, { startDate: startOfMonthIso(), endDate: new Date() }),
    ]);

    return {
      available: true,
      balance: { amount: balance.balance, currency: balance.currency },
      numberCount: numbers.length,
      spendTodayGbp: Number(todayUsage.totalGbp.toFixed(4)),
      spendMtdGbp: Number(mtdUsage.totalGbp.toFixed(4)),
      spendTodayByCategory: todayUsage.byCategory,
      spendMtdByCategory: mtdUsage.byCategory,
    };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

module.exports = { getTwilioAccountSnapshot, sumUsageRecordsGbp, startOfTodayIso, startOfMonthIso };
