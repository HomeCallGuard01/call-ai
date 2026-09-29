// Minimal in-memory stand-in for the subset of the supabase-js query
// builder used by database/deliveryEvidence.js and
// services/deliveryHealthMonitor.js. Supports: select, update, eq, is,
// not(col,'is',null), or('a.eq.x,b.eq.y'), order, limit, maybeSingle,
// and awaiting the builder directly. `missingColumns` simulates a
// database where a migration has not been applied: any query that
// mentions one of those columns returns a PostgREST-style error.

export function createFakeSupabase(tables, { missingColumns = [] } = {}) {
  const writes = [];

  function from(table) {
    const rows = tables[table] || (tables[table] = []);
    const filters = [];
    let op = 'select';
    let patch = null;
    let orderBy = null;
    let limitN = null;
    let returnSelect = false;
    const mentioned = [];

    const builder = {
      select(cols) {
        if (op === 'update') returnSelect = true;
        if (cols) mentioned.push(...cols.split(',').map(c => c.trim()));
        return builder;
      },
      update(values) { op = 'update'; patch = values; mentioned.push(...Object.keys(values)); return builder; },
      eq(col, val) { mentioned.push(col); filters.push(r => r[col] === val); return builder; },
      is(col, val) { mentioned.push(col); filters.push(r => (r[col] ?? null) === val); return builder; },
      not(col, operator, val) {
        mentioned.push(col);
        if (operator !== 'is' || val !== null) throw new Error('fake only supports not(col, "is", null)');
        filters.push(r => r[col] !== null && r[col] !== undefined);
        return builder;
      },
      or(expr) {
        const clauses = expr.split(',').map(part => {
          const [col, operator, ...rest] = part.split('.');
          if (operator !== 'eq') throw new Error('fake only supports eq in or()');
          mentioned.push(col);
          return { col, val: rest.join('.') };
        });
        filters.push(r => clauses.some(c => r[c.col] === c.val));
        return builder;
      },
      order(col, { ascending = true } = {}) { orderBy = { col, ascending }; return builder; },
      limit(n) { limitN = n; return builder; },
      maybeSingle() { return run(true); },
      then(resolve, reject) { return run(false).then(resolve, reject); },
    };

    async function run(single) {
      const missing = mentioned.find(c => missingColumns.includes(c));
      if (missing) return { data: null, error: { message: `column calls.${missing} does not exist` } };
      let matched = rows.filter(r => filters.every(f => f(r)));
      if (op === 'update') {
        for (const r of matched) Object.assign(r, patch);
        writes.push({ table, patch, count: matched.length });
        if (!returnSelect) return { data: null, error: null };
      }
      if (orderBy) {
        matched = [...matched].sort((a, b) => {
          const d = a[orderBy.col] < b[orderBy.col] ? -1 : a[orderBy.col] > b[orderBy.col] ? 1 : 0;
          return orderBy.ascending ? d : -d;
        });
      }
      if (limitN != null) matched = matched.slice(0, limitN);
      const copies = matched.map(r => ({ ...r }));
      if (single) {
        if (copies.length > 1) return { data: null, error: { message: 'multiple rows' } };
        return { data: copies[0] || null, error: null };
      }
      return { data: copies, error: null };
    }

    return builder;
  }

  return { from, writes, tables };
}

export function createFakeTwilio({ parents = {}, alerts = [] } = {}) {
  const fetched = [];
  const client = sid => ({
    fetch: async () => {
      fetched.push(sid);
      if (!(sid in parents)) throw new Error('20404 not found');
      return { sid, parentCallSid: parents[sid] };
    },
  });
  client.fetched = fetched;
  return {
    calls: client,
    monitor: { v1: { alerts: { list: async () => alerts } } },
    fetched,
  };
}
