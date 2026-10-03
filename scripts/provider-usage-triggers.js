// Twilio Usage Triggers for HCG's provider-side spend alarms (financial
// safety Layer B). DRY RUN BY DEFAULT: lists existing triggers and prints
// the ones it would create. Creating them is a change to the live Twilio
// account and needs Andrew's approval:
//   PROVIDER_TRIGGERS_CONFIRM=create node scripts/provider-usage-triggers.js --apply
// Triggers only NOTIFY (≈1 min after the threshold); they cannot cap
// spend. The callback is /webhooks/provider-usage-alert (signature-checked).
// Thresholds scale with entitled households (--households=N, default 10).
'use strict';

require('dotenv').config();

function plannedTriggers({ appUrl, households }) {
  const n = Math.max(1, households);
  const cb = `${String(appUrl).replace(/\/$/, '')}/webhooks/provider-usage-alert`;
  const daily = Math.max(15, Math.round(n * 0.5));    // ≈ 5× a normal day (≈ £0.10/household/day)
  const monthly = Math.max(150, Math.round(n * 6));   // ≈ the whole after-fees revenue of every household
  return [
    { friendlyName: `HCG daily total spend ≥ £${daily}`, usageCategory: 'totalprice', triggerValue: String(daily), recurring: 'daily', triggerBy: 'price', callbackUrl: cb },
    { friendlyName: `HCG monthly total spend ≥ £${monthly}`, usageCategory: 'totalprice', triggerValue: String(monthly), recurring: 'monthly', triggerBy: 'price', callbackUrl: cb },
    { friendlyName: `HCG daily inbound voice ≥ £${Math.round(daily * 0.7)}`, usageCategory: 'calls-inbound', triggerValue: String(Math.round(daily * 0.7)), recurring: 'daily', triggerBy: 'price', callbackUrl: cb },
    { friendlyName: `HCG phone numbers ≥ ${Math.ceil(n * 1.2) + 10}`, usageCategory: 'phonenumbers', triggerValue: String(Math.ceil(n * 1.2) + 10), recurring: 'daily', triggerBy: 'count', callbackUrl: cb },
  ];
}

async function main() {
  const apply = process.argv.includes('--apply');
  const hArg = process.argv.find((a) => a.startsWith('--households='));
  const households = hArg ? Number(hArg.slice(13)) : 10;
  const appUrl = process.env.APP_URL;
  if (!appUrl) throw new Error('APP_URL is required (the callback URL is built from it)');
  const planned = plannedTriggers({ appUrl, households });
  const { twilioRestClient } = require('../services/twilioClient');
  if (!twilioRestClient) throw new Error('Twilio credentials are required');

  const existing = await twilioRestClient.usage.triggers.list();
  console.log(`Existing usage triggers: ${existing.length}`);
  for (const t of existing) console.log(`  ${t.friendlyName} — ${t.usageCategory} ${t.triggerBy} ${t.triggerValue} ${t.recurring}`);
  console.log(`\nPlanned (${households} households):`);
  for (const t of planned) console.log(`  ${t.friendlyName} — ${t.usageCategory} ${t.triggerBy} ${t.triggerValue} ${t.recurring} → ${t.callbackUrl}`);

  if (!apply) { console.log('\nDRY RUN — nothing created.'); return; }
  if (process.env.PROVIDER_TRIGGERS_CONFIRM !== 'create') throw new Error('REFUSED: set PROVIDER_TRIGGERS_CONFIRM=create to create triggers on the live account');
  for (const t of planned) {
    if (existing.some((e) => e.friendlyName === t.friendlyName)) { console.log(`skip (exists): ${t.friendlyName}`); continue; }
    const created = await twilioRestClient.usage.triggers.create({ ...t, callbackMethod: 'POST' });
    console.log(`created ${created.sid}: ${t.friendlyName}`);
  }
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exitCode = 1; });

module.exports = { plannedTriggers };
