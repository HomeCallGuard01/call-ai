// Operational event stores (soft-launch integration 2026-10-04).
//   createRpcOpsEventStore(supabase) — migration 072 RPCs (DRAFT, not applied)
//   createMemoryOpsEventStore()      — identical semantics, for tests
// recordEvent is idempotent on event_key; deliveries are created only with a
// NEW event, so a retried scan or delivery can never duplicate either.
'use strict';

function createRpcOpsEventStore(supabase) {
  const rpc = async (name, params) => {
    const { data, error } = await supabase.rpc(name, params);
    if (error) throw new Error(`${name}: ${error.message || error}`);
    return data;
  };
  return {
    recordEvent: (event, deliveries) => rpc('ops_record_event', { p_event: event, p_deliveries: deliveries }),
    claimDue: ({ now, limit = 20, leaseSeconds = 120 }) => rpc('ops_claim_due_deliveries', { p_now: new Date(now).toISOString(), p_limit: limit, p_lease_seconds: leaseSeconds }),
    complete: ({ id, status, error = null, nextAttemptAt = null }) => rpc('ops_complete_delivery', { p_id: id, p_status: status, p_error: error, p_next_attempt_at: nextAttemptAt }),
    markSeen: ({ eventId, actor }) => rpc('ops_mark_event_seen', { p_event_id: eventId, p_actor: actor }),
    countEvents: async (eventType) => {
      const { count, error } = await supabase.from('ops_events').select('id', { count: 'exact', head: true }).eq('event_type', eventType);
      if (error) throw new Error(`ops_events count: ${error.message || error}`);
      return count;
    },
  };
}

function createMemoryOpsEventStore() {
  const events = new Map(); // key -> event
  const deliveries = []; // { id, event_id, channel, recipient_role, status, attempts, next_attempt_at, lease_until, last_error, sent_at }
  let seq = 0;
  return {
    events, deliveries,
    async recordEvent(event, planned) {
      if (events.has(event.event_key)) return { inserted: false, event: events.get(event.event_key) };
      const row = { ...event, id: `ev${++seq}`, seen_at: null, seen_by: null };
      events.set(event.event_key, row);
      for (const d of planned || []) {
        if (deliveries.some((x) => x.event_id === row.id && x.channel === d.channel && x.recipient_role === d.recipient_role)) continue;
        deliveries.push({ id: `dl${++seq}`, event_id: row.id, channel: d.channel, recipient_role: d.recipient_role, status: d.status || 'pending', attempts: 0, next_attempt_at: 0, lease_until: null, last_error: null, sent_at: null });
      }
      return { inserted: true, event: row };
    },
    async claimDue({ now, limit = 20, leaseSeconds = 120 }) {
      const t = new Date(now).getTime();
      const due = deliveries.filter((d) => d.channel !== 'dashboard' && (((d.status === 'pending' || d.status === 'retry') && d.next_attempt_at <= t) || (d.status === 'in_flight' && d.lease_until !== null && d.lease_until <= t))).slice(0, limit);
      for (const d of due) { d.status = 'in_flight'; d.attempts += 1; d.lease_until = t + Math.max(30, leaseSeconds) * 1000; }
      return due.map((d) => ({ delivery: { ...d }, event: [...events.values()].find((e) => e.id === d.event_id) }));
    },
    async complete({ id, status, error = null, nextAttemptAt = null }) {
      const d = deliveries.find((x) => x.id === id);
      if (d.status === 'sent' && status !== 'sent') throw new Error('delivery already sent');
      d.status = status; d.last_error = error; d.lease_until = null;
      if (status === 'sent') d.sent_at = Date.now();
      if (nextAttemptAt) d.next_attempt_at = new Date(nextAttemptAt).getTime();
      return d;
    },
    async countEvents(eventType) {
      return [...events.values()].filter((e) => e.event_type === eventType).length;
    },
    async markSeen({ eventId, actor }) {
      const e = [...events.values()].find((x) => x.id === eventId);
      if (e && !e.seen_at) { e.seen_at = Date.now(); e.seen_by = actor; }
      return e;
    },
  };
}

module.exports = { createRpcOpsEventStore, createMemoryOpsEventStore };
