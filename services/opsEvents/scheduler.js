// Operational-event schedule (launch sprint 2026-10-05): every 15 minutes,
// scan for new events (exactly once each), then deliver due notifications.
//
// OFF unless OPS_EVENTS_SCHEDULE_ENABLED=true. Needs migration 072. Email is a
// separate switch (OPS_NOTIFY_EMAIL_ENABLED, plus role addresses); with email
// off, events still appear on the admin dashboard (GET /admin/api/ops-events).
//
// Isolation: not on any entitlement, call, webhook or provisioning path.
// Every failure is caught and logged; a tick never overlaps the previous one;
// nothing here can throw into the process.
'use strict';

const { runOpsEventScan, deliverDueOpsEvents } = require('./runner');

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;

/**
 * @param {{ env?: object, loadSnapshots: Function, store: object, sender: object,
 *           intervalMs?: number, firstRunDelayMs?: number, log?: Function,
 *           setTimeoutFn?: Function, setIntervalFn?: Function }} deps
 * @returns {{ tick: Function, stop: Function } | null} null when disabled
 */
function startOpsEventSchedule({ env = process.env, loadSnapshots, store, sender, intervalMs = DEFAULT_INTERVAL_MS, firstRunDelayMs = FIRST_RUN_DELAY_MS, log = console.error, setTimeoutFn = setTimeout, setIntervalFn = setInterval } = {}) {
  if (env.OPS_EVENTS_SCHEDULE_ENABLED !== 'true') {
    console.log('OPS EVENTS: schedule disabled (OPS_EVENTS_SCHEDULE_ENABLED is not "true")');
    return null;
  }
  if (!loadSnapshots || !store) {
    log('OPS EVENTS: schedule not started — snapshot loader or store missing');
    return null;
  }
  let running = false;
  let intervalHandle = null;
  let stopped = false;

  async function tick() {
    if (running || stopped) return { skipped: true };
    running = true;
    try {
      const scan = await runOpsEventScan({ loadSnapshots, store, env, log });
      const delivery = await deliverDueOpsEvents({ store, sender, env, log });
      if (scan.recorded || delivery.sent || delivery.failed || scan.errors) {
        console.log('OPS EVENTS:', JSON.stringify({ scan, delivery }));
      }
      return { scan, delivery };
    } catch (err) {
      log('OPS EVENTS: tick failed:', err && err.message);
      return { error: true };
    } finally {
      running = false;
    }
  }

  const firstHandle = setTimeoutFn(() => {
    tick();
    intervalHandle = setIntervalFn(tick, intervalMs);
  }, firstRunDelayMs);

  return {
    tick,
    stop() {
      stopped = true;
      clearTimeout(firstHandle);
      if (intervalHandle) clearInterval(intervalHandle);
    },
  };
}

module.exports = { startOpsEventSchedule, DEFAULT_INTERVAL_MS };
