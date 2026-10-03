// allowanceNotices.js — delivers allowance warnings (75% / 90% / 100% used
// by default) to channels outside the app (customer allowance workstream,
// 2026-10-03).
//
// Threshold detection and the once-per-period guarantee belong to
// Financial Fortress: usageNotifier.js claims each point exactly once per
// household per period in usage_notifications (056) before calling the
// `deliver` hook. This module is that hook plus a sender:
//
//   deliver()  enqueues one allowance_notice_deliveries row per enabled
//              channel (062; PK = household, period, point, channel, and an
//              FK to the claim), so a channel can't send the same warning
//              twice even across restarts and concurrent calls.
//   process()  leases due rows, re-checks they still matter (same period,
//              not superseded by a higher point), sends, and records the
//              outcome with bounded retries.
//
// In-app needs no delivery: the read model (customerAllowance.js) carries
// warning.level and status, so the app shows the notice from state, never
// from a stream of messages (no spam, nothing to lose).
//
// OFF BY DEFAULT. ALLOWANCE_NOTICE_CHANNELS (comma list of email,push)
// enables channels; unset = in-app only. Customer wording is DRAFT and
// needs Andrew's approval before email is enabled. Push has no sending
// pipeline in HCG today (only Twilio VoIP pushes), so push rows are
// recorded as suppressed until one exists.
'use strict';

const https = require('https');

const KNOWN_CHANNELS = ['email', 'push'];
const KIND_RANK = { warn_75: 1, warn_90: 2, exhausted_100: 3 };
const MAX_ATTEMPTS = 5;
const STALE_AFTER_MS = 48 * 3600 * 1000;

function enabledChannels(env = process.env) {
  return String(env.ALLOWANCE_NOTICE_CHANNELS || '')
    .split(',').map((s) => s.trim()).filter((c) => KNOWN_CHANNELS.includes(c));
}

/** The usageMeter `deliverNotification` hook. Never throws. */
function createNoticeEnqueuer({ enqueue, env = process.env, log = console }) {
  return async function deliver({ householdId, periodStart, kind }) {
    const channels = enabledChannels(env);
    if (!channels.length || !householdId || !periodStart || !KIND_RANK[kind]) return { enqueued: 0 };
    try {
      await enqueue(channels.map((channel) => ({ householdId, periodStart, kind, channel })));
      return { enqueued: channels.length };
    } catch (err) {
      log.error('ALLOWANCE NOTICE ENQUEUE FAILED:', err.message);
      return { enqueued: 0 };
    }
  };
}

// DRAFT customer wording — product decision, not approved. Plain, calm,
// never implies the phone line itself stops working.
function noticeEmail(kind, allowance) {
  const resets = allowance && allowance.resetsAt
    ? new Date(allowance.resetsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'Europe/London' })
    : 'your next renewal';
  const remaining = allowance && Number.isFinite(allowance.remainingPercent) ? allowance.remainingPercent : null;
  if (kind === 'exhausted_100') {
    return {
      subject: "You've used this month's Home Call Guard call checking",
      text: [
        "You've used all of this month's call checking.",
        '',
        'Your phone still works normally and calls still reach you. Until your allowance resets on ' + resets
          + ', Home Call Guard will not listen to calls from unknown numbers for scam warning signs.',
        '',
        'Calls from your trusted contacts are not affected.',
        '',
        'You can see your usage in the Home Call Guard app or at homecallguard.co.uk/dashboard.',
      ].join('\n'),
    };
  }
  return {
    subject: 'Home Call Guard: ' + (remaining === null ? 'running low' : `${remaining}% of this month's call checking left`),
    text: [
      remaining === null
        ? "You're running low on this month's call checking."
        : `You have about ${remaining}% of this month's call checking left.`,
      '',
      'It resets on ' + resets + '. Your phone and your trusted contacts are not affected.',
      '',
      'You can see your usage in the Home Call Guard app or at homecallguard.co.uk/dashboard.',
    ].join('\n'),
  };
}

function sendViaResend({ to, subject, text }, env = process.env) {
  return new Promise((resolve) => {
    const apiKey = env.Resend_API_Key;
    if (!apiKey) return resolve({ ok: false, error: 'resend_not_configured' });
    const body = JSON.stringify({
      from: env.ALLOWANCE_NOTICE_FROM || 'Home Call Guard <notifications@mail.homecallguard.co.uk>',
      to: [to], subject, text,
    });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST', timeout: 5000,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300 ? { ok: true } : { ok: false, error: `http_${res.statusCode}` }));
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end(body);
  });
}

/**
 * One sender pass.
 * @param {object} deps { claimNoticeBatch, completeNoticeDelivery, getHouseholdById,
 *                        getCurrentAllowance(household) → customerAllowance, sendEmail? }
 */
async function processAllowanceNotices({ deps, now = new Date(), env = process.env, limit = 25 }) {
  const sendEmail = deps.sendEmail || ((msg) => sendViaResend(msg, env));
  const rows = await deps.claimNoticeBatch({ now, limit });
  const results = [];
  for (const row of rows) {
    const key = { householdId: row.household_id, periodStart: row.period_start, kind: row.kind, channel: row.channel };
    const finish = async (status, extra = {}) => {
      await deps.completeNoticeDelivery({ ...key, status, ...extra });
      results.push({ ...key, status, ...(extra.error ? { error: extra.error } : {}) });
    };
    try {
      if (!enabledChannels(env).includes(row.channel)) { await finish('suppressed', { error: 'channel_disabled' }); continue; }
      if (row.channel === 'push') { await finish('suppressed', { error: 'no_push_pipeline' }); continue; }
      if (now - new Date(row.created_at) > STALE_AFTER_MS) { await finish('suppressed', { error: 'stale' }); continue; }

      const household = await deps.getHouseholdById(row.household_id);
      if (!household || !household.email) { await finish('suppressed', { error: 'no_email' }); continue; }
      const current = await deps.getCurrentAllowance(household);
      const allowance = current && current.allowance;
      // Period already reset, or usage no longer at this point (e.g. a
      // top-up landed first): the warning no longer describes reality.
      if (!allowance || !allowance.periodStartsAt
        || new Date(allowance.periodStartsAt).getTime() !== new Date(row.period_start).getTime()) {
        await finish('suppressed', { error: 'period_changed' }); continue;
      }
      const reachedRank = current.warning && current.warning.level ? KIND_RANK[current.warning.level === 100 ? 'exhausted_100' : `warn_${current.warning.level}`] : 0;
      if (reachedRank > KIND_RANK[row.kind]) { await finish('suppressed', { error: 'superseded' }); continue; }
      if (row.kind !== 'exhausted_100' && allowance.usedPercent !== null && allowance.usedPercent < Number(row.kind.slice(5))) {
        await finish('suppressed', { error: 'no_longer_applicable' }); continue;
      }

      const sent = await sendEmail({ to: household.email, ...noticeEmail(row.kind, allowance) });
      if (sent && sent.ok) { await finish('sent'); continue; }
      throw new Error((sent && sent.error) || 'send_failed');
    } catch (err) {
      const giveUp = Number(row.attempts) >= MAX_ATTEMPTS;
      const retryAt = new Date(now.getTime() + 5 * 60000 * 2 ** Math.max(0, Number(row.attempts) - 1));
      await deps.completeNoticeDelivery({ ...key, status: giveUp ? 'suppressed' : 'failed', nextAttemptAt: giveUp ? null : retryAt, error: `${giveUp ? 'gave_up: ' : ''}${err.message}` }).catch(() => {});
      results.push({ ...key, status: giveUp ? 'suppressed' : 'failed', error: err.message });
    }
  }
  return results;
}

module.exports = { enabledChannels, createNoticeEnqueuer, processAllowanceNotices, noticeEmail, MAX_ATTEMPTS };
