// Paginated read for the dashboard (2026-10-01). PostgREST caps a single
// response (1000 rows by default on Supabase) regardless of .limit(), so a
// single query silently undercounts once a table grows past it. This
// pages with .range() until a short page, and says when it stopped at the
// safety ceiling instead of pretending the result is complete.
// `build()` must return a fresh, fully filtered and ORDERED query each
// call (stable order is what makes ranges non-overlapping).
'use strict';

async function selectAll(build, { page = 1000, maxRows = 50000 } = {}) {
  const data = [];
  for (let from = 0; ; from += page) {
    const res = await build().range(from, from + page - 1);
    if (res.error) return { data: null, error: res.error, truncated: false };
    const rows = res.data || [];
    data.push(...rows);
    if (rows.length < page) return { data, error: null, truncated: false };
    if (data.length >= maxRows) return { data, error: null, truncated: true };
  }
}

module.exports = { selectAll };
