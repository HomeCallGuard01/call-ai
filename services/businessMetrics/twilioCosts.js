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

// Bug fix (2026-09-27, business control dashboard): the category
// allow-list below missed real cost lines on this account — UK number
// rental is billed as "phonenumbers-local" (not "phonenumbers"), and
// Media Streams ("calls-media-stream-minutes"), text-to-speech and
// channels were never counted. Confirmed read-only against the live
// account for 1-27 Sep 2026: Twilio's own total was £16.50 while this
// function reported £0.70 (number rental £15.65 missing entirely).
//
// Twilio's categories are hierarchical ("calls-inbound" contains
// "calls-inbound-local"; "amazon-polly" duplicates "calls-text-to-
// speech"), so adding categories to an allow-list risks double-counting.
// The authoritative total is Twilio's own "totalprice" record; number
// rental is the "phonenumbers" family (the parent if Twilio reports it,
// otherwise its children, never both). The legacy allow-list sum is kept
// only as a fallback for a response with no "totalprice" record.
const LEGACY_COST_CATEGORIES = ['calls-inbound', 'calls-outbound', 'phonenumbers', 'sms', 'sms-outbound', 'sms-inbound', 'trunking-termination', 'trunking-origination'];

function rentalFromRecords(records) {
  const priced = (records || []).filter((r) => Math.abs(Number(r.price) || 0) > 0);
  const parent = priced.find((r) => r.category === 'phonenumbers');
  if (parent) return Math.abs(Number(parent.price));
  return sumUsageRecordsGbp(priced.filter((r) => typeof r.category === 'string' && r.category.startsWith('phonenumbers-')));
}

async function fetchUsageTotalGbp(client, { startDate, endDate }) {
  const records = await client.usage.records.list({ startDate, endDate, limit: 1000 });
  const totalRecord = records.find((r) => r.category === 'totalprice');
  const legacy = records.filter((r) => LEGACY_COST_CATEGORIES.includes(r.category));
  const totalGbp = totalRecord ? Math.abs(Number(totalRecord.price) || 0) : sumUsageRecordsGbp(legacy);
  const rentalGbp = rentalFromRecords(records);
  // Display-only breakdown: every priced category except the overall
  // total. Categories can overlap, so never sum this list — use totalGbp.
  // `usageUnit` is the SDK's camelCase field (2026-09 fix, unchanged).
  const byCategory = records
    .filter((r) => r.category !== 'totalprice' && Math.abs(Number(r.price) || 0) > 0)
    .map((r) => ({ category: r.category, usage: r.usage, usageUnit: r.usageUnit, priceGbp: Number(r.price) || 0 }));
  return { totalGbp, rentalGbp, totalSource: totalRecord ? 'twilio_totalprice' : 'category_sum', byCategory };
}

// Splits Twilio spend into number rental vs. everything else (calls,
// media streams, TTS, SMS, channels). When fetchUsageTotalGbp's totals
// are passed (the normal path), usage = Twilio's total − rental, so
// nothing is double-counted or dropped. Without them it falls back to
// the original behaviour over a byCategory list.
function splitRentalVsUsageGbp(byCategory, totals) {
  if (totals && Number.isFinite(totals.totalGbp) && Number.isFinite(totals.rentalGbp)) {
    const rental = totals.rentalGbp;
    const usage = Math.max(0, totals.totalGbp - rental);
    return { numberRentalGbp: Number(rental.toFixed(4)), callUsageGbp: Number(usage.toFixed(4)) };
  }
  let numberRentalGbp = 0;
  let callUsageGbp = 0;
  for (const row of byCategory || []) {
    if (row.category === 'phonenumbers') {
      numberRentalGbp += row.priceGbp;
    } else {
      callUsageGbp += row.priceGbp;
    }
  }
  return { numberRentalGbp: Number(numberRentalGbp.toFixed(4)), callUsageGbp: Number(callUsageGbp.toFixed(4)) };
}

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
      spendTodaySplit: splitRentalVsUsageGbp(todayUsage.byCategory, todayUsage),
      spendMtdSplit: splitRentalVsUsageGbp(mtdUsage.byCategory, mtdUsage),
    };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

module.exports = {
  getTwilioAccountSnapshot,
  sumUsageRecordsGbp,
  fetchUsageTotalGbp,
  splitRentalVsUsageGbp,
  startOfTodayIso,
  startOfMonthIso,
};
