'use strict';

// Telephony abuse P0 — process-local velocity primitives.
//
// Sliding-window event counters, temporary cooldowns, and TTL leases for
// concurrency. All bounded in memory (no unbounded growth under a flood of
// distinct keys) and all clock-injectable for tests.
//
// LIMITATION (documented in the threat model as PARTIAL): state is per
// process. HCG runs one Railway instance today; a restart clears counters
// and a second instance would halve their effectiveness. The store
// interface (hit/count/cooldown/lease) is what a shared implementation
// (Postgres table in the provisional migration, or Claude 1's admission
// RPC) has to provide.

const DEFAULT_MAX_KEYS = 50000;
const MAX_EVENTS_PER_KEY = 1000;

function createVelocityStore({ now = () => Date.now(), maxKeys = DEFAULT_MAX_KEYS } = {}) {
  const events = new Map();    // key -> number[] (ascending timestamps)
  const cooldowns = new Map(); // key -> { until, reason }
  const leases = new Map();    // leaseId -> { key, expiresAt }
  const members = new Map();   // key -> Map(member -> lastSeen)

  function evictIfNeeded(map) {
    if (map.size <= maxKeys) return;
    // Oldest-inserted first; Map iteration order is insertion order.
    const excess = map.size - maxKeys;
    let i = 0;
    for (const k of map.keys()) { if (i++ >= excess) break; map.delete(k); }
  }

  function prune(key, windowMs) {
    const list = events.get(key);
    if (!list) return [];
    const cutoff = now() - windowMs;
    let drop = 0;
    while (drop < list.length && list[drop] <= cutoff) drop++;
    if (drop) list.splice(0, drop);
    if (!list.length) events.delete(key);
    return list;
  }

  return {
    /** Record one event and return the count inside the window (including this one). */
    hit(key, windowMs) {
      const list = prune(key, windowMs);
      const target = list.length ? list : [];
      target.push(now());
      if (target.length > MAX_EVENTS_PER_KEY) target.splice(0, target.length - MAX_EVENTS_PER_KEY);
      if (!events.has(key)) { events.set(key, target); evictIfNeeded(events); }
      return target.length;
    },
    count(key, windowMs) {
      return prune(key, windowMs).length;
    },
    /** Record `member` under `key`; return how many DISTINCT members were seen inside the window. */
    distinct(key, member, windowMs) {
      let m = members.get(key);
      if (!m) { m = new Map(); members.set(key, m); evictIfNeeded(members); }
      const t = now();
      m.delete(member); // re-insert keeps the Map ordered by last-seen
      m.set(member, t);
      for (const [k, at] of m) { if (at > t - windowMs) break; m.delete(k); }
      while (m.size > MAX_EVENTS_PER_KEY) m.delete(m.keys().next().value);
      return m.size;
    },
    setCooldown(key, ms, reason) {
      const until = now() + ms;
      const existing = cooldowns.get(key);
      // Never EXTEND an active cooldown on repeat triggers beyond a fresh
      // window: an attacker re-triggering cannot make a block permanent.
      if (!existing || existing.until < until) cooldowns.set(key, { until, reason });
      evictIfNeeded(cooldowns);
    },
    getCooldown(key) {
      const c = cooldowns.get(key);
      if (!c) return null;
      if (c.until <= now()) { cooldowns.delete(key); return null; }
      return c;
    },
    acquireLease(key, leaseId, ttlMs) {
      leases.set(leaseId, { key, expiresAt: now() + ttlMs });
      evictIfNeeded(leases);
    },
    releaseLease(leaseId) {
      return leases.delete(leaseId);
    },
    activeLeases(key) {
      const t = now();
      let n = 0;
      for (const [id, l] of leases) {
        if (l.expiresAt <= t) { leases.delete(id); continue; }
        if (l.key === key) n++;
      }
      return n;
    },
    /** Drop every lease for `key` (provider confirmed fewer live calls than we counted). */
    clearLeases(key) {
      for (const [id, l] of leases) if (l.key === key) leases.delete(id);
    },
    _sizes: () => ({ events: events.size, cooldowns: cooldowns.size, leases: leases.size, members: members.size }),
  };
}

module.exports = { createVelocityStore };
