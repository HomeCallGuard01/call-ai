#!/usr/bin/env node
// Rollback compatibility check — READ-ONLY, STATIC (WS1 2026-10-10).
//
// Question: if the candidate is deployed (migrations 047, 051–075 applied) and
// then rolled back to the old backend (production eb43368, procedure §8 R1),
// does eb43368's database access still work against the NEW schema?
//
// Method (no database, no network; source only):
//   1. Replays supabase/migrations/*.sql (in this worktree) twice into a
//      symbolic schema: through 046 (what eb43368 was written for) and through
//      075 (after the deploy) — tables/columns, function overloads (IN-param
//      names, defaults, body), function EXECUTE grants for service_role,
//      table privileges revoked from anon/authenticated, new CHECK/UNIQUE
//      constraints, new triggers on existing tables.
//   2. Reads eb43368's server-side JS with `git show eb43368:<path>` (server.js,
//      database/, services/, routes/, middleware/) and extracts every
//      `<client>.from("table")` chain (columns selected / filtered / written,
//      and which client: service-role vs user-scoped) and every
//      `.rpc("fn", { named args })` call.
//   3. Classifies each dependency:
//        BREAKING  — something eb43368 uses exists at 046 but is gone, renamed,
//                    retyped or no longer callable at 075, or a privilege it
//                    relies on was revoked;
//        REVIEW    — still callable but the 047–075 change could alter
//                    behaviour (replaced function body, new constraint on a
//                    column it writes, new trigger on a table it writes). Each
//                    REVIEW item must have a written verdict in REVIEWED below,
//                    otherwise the check fails (so a future migration that
//                    touches something eb43368 uses forces a fresh review);
//        OK        — unchanged.
//
// Limits (stated, not hidden): a static parse, not execution. Dynamic table or
// column names, and row objects built elsewhere and passed as a variable, are
// listed as "dynamic" rather than verified. PostgREST/RLS behaviour and
// function bodies' runtime semantics are NOT executed here — the REVIEW
// verdicts are reasoned from the SQL. See docs/launch/2026-10-10-WS1-REPORT.md §5.
//
// Usage: node scripts/production/rollback-compat-check.mjs [--old eb43368] [--json]
// Exit:  0 no BREAKING and every REVIEW has a verdict · 2 otherwise · 1 error.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Written verdicts for every REVIEW item (key = kind:object). Reasoned from the
// migration SQL; see the report for the evidence lines.
export const REVIEWED = {
  'function:mark_household_twilio_number_pending_release': '047 keeps the signature (p_household_id uuid, p_grace_period interval) and adds the entitlement guard: it now refuses to start a release clock for a household that is currently or upcoming entitled. eb43368 only calls it after losing an entitlement; a refusal is the intended safer outcome (no number lost).',
  'function:release_household_twilio_number': '047 keeps the signature (p_household_id, p_expected_number) and refuses release while the household is entitled. eb43368 releases the Twilio number only when the RPC returns true, so a refusal releases nothing (safer).',
  'function:release_household_twilio_number_immediately': '047 keeps the signature (p_household_id) and refuses while entitled. eb43368 does not call it from any live path (its own comment: "not called from anywhere in this codebase yet").',
  'function:set_household_carrier_compatibility': '065 replaces it with the same 4 named parameters (p_household_id, p_device_type, p_provider_key, p_tariff_type) and widens the accepted device types (iphone). eb43368 passes exactly those 4 names.',
  'function:process_stripe_webhook_event': '070 keeps the exact parameter list of 027 (diffed in the 2026-10-05 runbook §0) and changes only the canonical entitlement decision inside; eb43368 passes the same params object.',
  'trigger:entitlements': '047 adds an AFTER INSERT/UPDATE trigger that cancels a pending number release when an entitlement becomes active — the same thing eb43368 already does via cancel_household_twilio_number_pending_release; it never blocks the write.',
  'trigger:households': '062 adds (a) BEFORE/AFTER triggers (SECURITY DEFINER) that assign and register households.account_number — a caller-supplied value is ignored, eb43368 never writes account_number, and the user-scoped INSERT in ensureHouseholdAndRole needs no privilege on hcg_account_numbers because the functions are SECURITY DEFINER (and trigger-function EXECUTE is checked at CREATE TRIGGER, not at fire time); (b) households_mirror_twilio_number (AFTER INSERT / UPDATE OF twilio_number, SECURITY DEFINER), whose body is wrapped in `exception when others` → anomaly row, never an error, so eb43368\'s number assignment/release RPCs cannot be failed by it.',
  'column:households.account_number': '062 sets account_number NOT NULL only after backfilling every row, and its BEFORE INSERT trigger households_account_number_assign (SECURITY DEFINER) always assigns the value from the sequence, ignoring the caller. eb43368 inserts households without account_number (ensureHouseholdAndRole) and the trigger fills it, so the NOT NULL cannot fail.',
  'trigger:twilio_number_quarantine': '062 adds twilio_quarantine_mirror (AFTER INSERT / UPDATE OF released_at, SECURITY DEFINER). Its body is wrapped in `exception when others` → records an identity anomaly and returns; it can never fail eb43368\'s quarantine write.',
  'constraint:account_classifications.account_classifications_classification_check': '069 replaces the 031 CHECK with a superset (adds other_non_customer). eb43368 writes only internal_test.',
};

// ── SQL replay ──────────────────────────────────────────────────────────
function stripComments(sql) { return sql.replace(/--[^\n]*/g, ''); }
function splitTopLevel(s, sep = ',') {
  const out = []; let depth = 0; let cur = ''; let q = false;
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (!q && ch === '(') depth++;
    if (!q && ch === ')') depth--;
    if (!q && depth === 0 && ch === sep) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
function matchParen(s, open) { let d = 0; for (let i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (!d) return i; } } return -1; }
const TYPE_ALIAS = { int: 'integer', int4: 'integer', int8: 'bigint', bool: 'boolean', varchar: 'character varying', 'timestamp with time zone': 'timestamptz', float8: 'double precision' };
function normType(t) { const x = t.toLowerCase().replace(/\s+/g, ' ').replace(/^public\./, '').trim(); return TYPE_ALIAS[x] || x; }
function parseParams(list) {
  return splitTopLevel(list).map((p) => {
    let s = p.trim(); let mode = 'in';
    const mm = /^(in|out|inout|variadic)\s+/i.exec(s); if (mm) { mode = mm[1].toLowerCase(); s = s.slice(mm[0].length); }
    const def = /\s(default\s|=\s*)/i.exec(s);
    const head = def ? s.slice(0, def.index) : s;
    const parts = head.trim().split(/\s+/);
    const name = parts.length > 1 ? parts[0].toLowerCase() : null;
    const type = normType(parts.length > 1 ? parts.slice(1).join(' ') : parts[0]);
    return { name, type, mode, hasDefault: !!def };
  });
}
const sigKey = (name, params) => `${name}(${params.filter((p) => p.mode !== 'out').map((p) => p.type).join(',')})`;

export function emptySchema() { return { tables: new Map(), functions: new Map(), fnGrants: new Map(), constraints: new Map(), triggers: new Map(), revokedFromAuthenticated: new Map(), granted: new Map() }; }

// Conservative: any revoke from anon/authenticated on a table clears every
// earlier recorded grant on it; only grants made AFTER it count.
function revokeAllFrom(schema, t, file) {
  schema.revokedFromAuthenticated.set(t, file);
  for (const k of [...schema.granted.keys()]) if (k.startsWith(`${t}:`)) schema.granted.delete(k);
}

export function applyMigration(schema, file, rawSql) {
  const sql = stripComments(rawSql);
  const changes = [];
  // functions (with bodies)
  const fnRe = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(\w+)\s*\(/gi; let m;
  while ((m = fnRe.exec(sql))) {
    const open = m.index + m[0].length - 1; const close = matchParen(sql, open);
    const params = parseParams(sql.slice(open + 1, close));
    const bodyM = /\$(\w*)\$([\s\S]*?)\$\1\$/.exec(sql.slice(close));
    const key = sigKey(m[1].toLowerCase(), params);
    const prev = schema.functions.get(key);
    schema.functions.set(key, { name: m[1].toLowerCase(), params, body: bodyM ? bodyM[2].replace(/\s+/g, ' ').trim() : '', file });
    changes.push({ kind: prev ? 'function-replaced' : 'function-created', key, file });
  }
  // 059-style dynamic revoke inside a DO block: every table existing at this
  // point loses all anon/authenticated privileges (re-grants follow).
  if (/revoke all on table %s from public, anon, authenticated/i.test(sql)) {
    for (const t of schema.tables.keys()) { revokeAllFrom(schema, t, file); changes.push({ kind: 'privilege-revoked', key: t, file }); }
  }
  const noBodies = sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '$$$$');
  for (const stmt of noBodies.split(';').map((s) => s.trim()).filter(Boolean)) {
    let x;
    if ((x = /^drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?(\w+)\s*(\(([\s\S]*)\))?/i.exec(stmt))) {
      const name = x[1].toLowerCase();
      if (x[2] !== undefined) {
        const types = x[3].trim() ? splitTopLevel(x[3]).map((t) => normType(t.replace(/^(in|inout|variadic)\s+/i, '').split(/\s+/).length > 1 && !/\b(with|precision|varying)\b/i.test(t) ? t.trim().split(/\s+/).slice(1).join(' ') : t)) : [];
        const key = `${name}(${types.join(',')})`;
        if (schema.functions.delete(key)) changes.push({ kind: 'function-dropped', key, file });
      } else {
        for (const k of [...schema.functions.keys()]) if (k.startsWith(`${name}(`)) { schema.functions.delete(k); changes.push({ kind: 'function-dropped', key: k, file }); }
      }
      continue;
    }
    if ((x = /^create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*)\)\s*$/i.exec(stmt))) {
      const t = x[1].toLowerCase();
      if (!schema.tables.has(t)) schema.tables.set(t, { columns: new Set(), file });
      for (const col of splitTopLevel(x[2])) {
        const first = col.split(/\s+/)[0].toLowerCase().replace(/"/g, '');
        if (['constraint', 'primary', 'unique', 'check', 'foreign', 'exclude', 'like'].includes(first)) continue;
        schema.tables.get(t).columns.add(first);
      }
      continue;
    }
    if ((x = /^drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?(\w+)/i.exec(stmt))) { const t = x[1].toLowerCase(); if (schema.tables.delete(t)) changes.push({ kind: 'table-dropped', key: t, file }); continue; }
    if ((x = /^alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:public\.)?(\w+)\s+([\s\S]*)$/i.exec(stmt))) {
      const t = x[1].toLowerCase(); const rest = x[2];
      const tbl = schema.tables.get(t) || { columns: new Set(), file };
      schema.tables.set(t, tbl);
      let y;
      const addRe = /add\s+column\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?/gi; while ((y = addRe.exec(rest))) { tbl.columns.add(y[1].toLowerCase()); changes.push({ kind: 'column-added', key: `${t}.${y[1].toLowerCase()}`, file }); }
      const dropRe = /drop\s+column\s+(?:if\s+exists\s+)?"?(\w+)"?/gi; while ((y = dropRe.exec(rest))) { tbl.columns.delete(y[1].toLowerCase()); changes.push({ kind: 'column-dropped', key: `${t}.${y[1].toLowerCase()}`, file }); }
      const renRe = /rename\s+column\s+"?(\w+)"?\s+to\s+"?(\w+)"?/gi; while ((y = renRe.exec(rest))) { tbl.columns.delete(y[1].toLowerCase()); tbl.columns.add(y[2].toLowerCase()); changes.push({ kind: 'column-renamed', key: `${t}.${y[1].toLowerCase()}`, file }); }
      const typeRe = /alter\s+column\s+"?(\w+)"?\s+(?:set\s+data\s+)?type\s/gi; while ((y = typeRe.exec(rest))) changes.push({ kind: 'column-retyped', key: `${t}.${y[1].toLowerCase()}`, file });
      const nnRe = /alter\s+column\s+"?(\w+)"?\s+set\s+not\s+null/gi; while ((y = nnRe.exec(rest))) changes.push({ kind: 'column-not-null', key: `${t}.${y[1].toLowerCase()}`, file });
      const conRe = /add\s+constraint\s+(\w+)\s+(check|unique|foreign\s+key)\s*\(([\s\S]*)$/gi; while ((y = conRe.exec(rest))) { const k = `${t}.${y[1].toLowerCase()}`; schema.constraints.set(k, { table: t, kind: y[2].toLowerCase(), expr: y[3], file }); changes.push({ kind: 'constraint-added', key: k, file }); }
      if (/^rename\s+to\s/i.test(rest.trim())) changes.push({ kind: 'table-renamed', key: t, file });
      continue;
    }
    if ((x = /^create\s+trigger\s+(\w+)[\s\S]*?\bon\s+(?:public\.)?(\w+)/i.exec(stmt))) { const t = x[2].toLowerCase(); schema.triggers.set(`${t}.${x[1].toLowerCase()}`, { table: t, file }); changes.push({ kind: 'trigger-added', key: `${t}.${x[1].toLowerCase()}`, table: t, file }); continue; }
    if ((x = /^(revoke|grant)\s+([\s\S]+?)\s+on\s+function\s+(?:public\.)?(\w+)[\s\S]*?\s(from|to)\s+([\w\s,]+)$/i.exec(stmt))) {
      const roles = x[5].toLowerCase().split(/[\s,]+/);
      if (roles.includes('service_role')) schema.fnGrants.set(x[3].toLowerCase(), { state: x[1].toLowerCase(), file });
      continue;
    }
    if ((x = /^(revoke|grant)\s+([\s\S]+?)\s+on\s+(?:table\s+)?((?:public\.)?\w+(?:\s*,\s*(?:public\.)?\w+)*)\s+(from|to)\s+([\w\s,]+)$/i.exec(stmt))) {
      const roles = x[5].toLowerCase().split(/[\s,]+/);
      if (!roles.includes('authenticated') && !roles.includes('anon')) continue;
      for (const tname of x[3].split(',').map((s) => s.trim().replace(/^public\./, '').toLowerCase())) {
        if (x[1].toLowerCase() === 'revoke') { revokeAllFrom(schema, tname, file); changes.push({ kind: 'privilege-revoked', key: tname, file }); }
        else schema.granted.set(`${tname}:${x[2].toLowerCase().replace(/\s+/g, ' ')}`, file);
      }
    }
  }
  return changes;
}

export function replay(migrationsDir, { through }) {
  const schema = emptySchema(); const changes = [];
  const files = readdirSync(migrationsDir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  for (const f of files) {
    if (f.slice(0, 3) > through) break;
    changes.push(...applyMigration(schema, f, readFileSync(path.join(migrationsDir, f), 'utf8')));
  }
  return { schema, changes };
}

// ── eb43368 source extraction ───────────────────────────────────────────
const gitShow = (rev, p) => execFileSync('git', ['show', `${rev}:${p}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
export function oldBackendFiles(rev) {
  return execFileSync('git', ['ls-tree', '-r', '--name-only', rev], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.js$/.test(f) && (/^(database|services|routes|middleware)\//.test(f) || f === 'server.js'));
}
const FILTERS = /\.(eq|neq|is|in|gt|gte|lt|lte|order|not|like|ilike|contains|containedBy|filter|match)\(\s*["'`](\w+)/g;
function objectKeys(src, start) {
  const open = src.indexOf('{', start); if (open < 0) return null;
  let d = 0; let end = -1;
  for (let i = open; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) { end = i; break; } } }
  if (end < 0) return null;
  const inner = src.slice(open + 1, end); const keys = new Set();
  let depth = 0; let tok = '';
  for (const ch of inner) {
    if ('{[('.includes(ch)) depth++;
    if ('}])'.includes(ch)) depth--;
    if (depth === 0 && ch === ',') { const k = /^\s*(?:\.\.\.)?\s*["']?(\w+)["']?\s*(?::|$)/.exec(tok); if (k && !tok.trim().startsWith('...')) keys.add(k[1]); tok = ''; continue; }
    tok += ch;
  }
  const k = /^\s*["']?(\w+)["']?\s*(?::|$)/.exec(tok); if (k && !tok.trim().startsWith('...')) keys.add(k[1]);
  return keys;
}
// The method chain that follows `.from("t")`: stops at the first `;`, `,`,
// `)` or `]` at depth 0 (end of statement / array element / argument), so
// sibling queries inside Promise.all([...]) are never merged.
function chainText(src, from, start) {
  let depth = 0; let q = null;
  for (let i = from; i < src.length && i < from + 4000; i++) {
    const ch = src[i];
    if (q) { if (ch === '\\') { i++; continue; } if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { if (depth === 0) return src.slice(start, i); depth--; }
    else if (depth === 0 && (ch === ';' || ch === ',')) return src.slice(start, i);
  }
  return src.slice(start, from + 4000);
}

export function extractUsage(files) {
  const tables = new Map(); const rpcs = [];
  const use = (t) => { if (!tables.has(t)) tables.set(t, { read: new Set(), write: new Set(), clients: new Set(), dynamicWrites: [], sites: [], byClient: new Map() }); return tables.get(t); };
  for (const { file, src } of files) {
    const fromRe = /([A-Za-z_$][\w$]*)\s*\.from\(\s*["'`](\w+)["'`]\s*\)/g; let m;
    while ((m = fromRe.exec(src))) {
      if (m[1] === 'Buffer' || m[1] === 'Array') continue;
      const t = m[2]; const u = use(t);
      const line = src.slice(0, m.index).split('\n').length;
      u.clients.add(m[1]); u.sites.push(`${file}:${line}`);
      if (!u.byClient.has(m[1])) u.byClient.set(m[1], { select: false, insert: new Set(), update: new Set(), del: false, dynamic: false });
      const bc = u.byClient.get(m[1]);
      const chain = chainText(src, m.index + m[0].length, m.index);
      if (/\.select\(/.test(chain)) bc.select = true;
      if (/\.delete\(/.test(chain)) bc.del = true;
      let s; const selRe = /\.select\(\s*["'`]([^"'`]*)["'`]/g;
      while ((s = selRe.exec(chain))) for (const c of splitTopLevel(s[1])) { const col = c.replace(/^\w+:/, '').replace(/::\w+$/, '').replace(/\(.*$/, '').replace(/!\w+$/, '').trim(); if (col && col !== '*' && /^\w+$/.test(col) && !/\(/.test(c)) u.read.add(col); }
      FILTERS.lastIndex = 0; while ((s = FILTERS.exec(chain))) u.read.add(s[2]);
      const oc = /onConflict:\s*["'`]([\w,\s]+)["'`]/.exec(chain); if (oc) for (const c of oc[1].split(',')) u.read.add(c.trim());
      const wRe = /\.(insert|update|upsert)\(\s*/g;
      while ((s = wRe.exec(chain))) {
        const after = chain.slice(s.index + s[0].length);
        if (after.startsWith('{') || after.startsWith('[{') || after.startsWith('[\n') || after.startsWith('[ {')) { const keys = objectKeys(chain, s.index + s[0].length); if (keys) for (const k of keys) { u.write.add(k); bc[s[1] === 'update' ? 'update' : 'insert'].add(k); } }
        else if ((bc.dynamic = true)) u.dynamicWrites.push(`${file}:${line} ${s[1]}(${after.slice(0, 30).split(/[,)]/)[0]})`);
      }
    }
    const rpcRe = /([A-Za-z_$][\w$]*)\s*\.rpc\(\s*["'`](\w+)["'`]\s*(,\s*)?/g;
    while ((m = rpcRe.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length;
      const after = src.slice(m.index + m[0].length);
      const keys = m[3] && after.startsWith('{') ? objectKeys(src, m.index + m[0].length) : null;
      rpcs.push({ fn: m[2].toLowerCase(), client: m[1], keys: keys ? [...keys] : null, dynamic: !!m[3] && !after.startsWith('{'), site: `${file}:${line}` });
    }
  }
  return { tables, rpcs };
}

// ── classification ──────────────────────────────────────────────────────
function callable(schema, fn, keys) {
  const overloads = [...schema.functions.values()].filter((f) => f.name === fn);
  if (!overloads.length) return { ok: false, why: 'no such function' };
  for (const o of overloads) {
    const ins = o.params.filter((p) => p.mode !== 'out');
    const names = new Set(ins.map((p) => p.name));
    const required = ins.filter((p) => !p.hasDefault).map((p) => p.name);
    if (keys === null) return { ok: true, overload: o, dynamic: true };
    if (keys.every((k) => names.has(k.toLowerCase())) && required.every((r) => keys.map((k) => k.toLowerCase()).includes(r))) return { ok: true, overload: o };
  }
  return { ok: false, why: `no overload accepts {${(keys || []).join(', ')}}; have ${overloads.map((o) => sigKey(o.name, o.params)).join(' | ')}` };
}

export function classify({ before, after, changes, usage }) {
  const findings = [];
  const push = (level, key, detail) => findings.push({ level, key, detail, verdict: level === 'REVIEW' ? REVIEWED[key] || null : null });
  // RPCs
  const seenFn = new Set();
  for (const r of usage.rpcs) {
    if (seenFn.has(r.fn)) continue; seenFn.add(r.fn);
    const b = callable(before.schema, r.fn, r.keys); const a = callable(after.schema, r.fn, r.keys);
    const g = after.schema.fnGrants.get(r.fn);
    if (b.ok && !a.ok) { push('BREAKING', `function:${r.fn}`, `${r.site}: callable at 046 but not at 075 — ${a.why}`); continue; }
    if (!b.ok && !a.ok) { push('UNRESOLVED', `function:${r.fn}`, `${r.site}: not found in migrations at 046 or 075 (${a.why}) — defined outside the migration history?`); continue; }
    if (g && g.state === 'revoke' && r.client === 'supabaseAdmin') { push('BREAKING', `function:${r.fn}`, `service_role EXECUTE revoked in ${g.file}`); continue; }
    if (b.ok && a.ok && a.overload.body !== b.overload.body) push('REVIEW', `function:${r.fn}`, `${r.site}: same call shape, body replaced in ${a.overload.file}`);
    else push('OK', `function:${r.fn}`, `${r.site}: unchanged`);
  }
  // Tables / columns
  for (const [t, u] of usage.tables) {
    const tb = before.schema.tables.get(t); const ta = after.schema.tables.get(t);
    if (tb && !ta) { push('BREAKING', `table:${t}`, `dropped (${u.sites[0]})`); continue; }
    if (!tb && !ta) { push('UNRESOLVED', `table:${t}`, `not created by any migration (${u.sites[0]})`); continue; }
    for (const c of new Set([...u.read, ...u.write])) {
      if (tb && tb.columns.has(c) && !ta.columns.has(c)) push('BREAKING', `column:${t}.${c}`, 'exists at 046, gone at 075');
      else if (!ta.columns.has(c)) push('UNRESOLVED', `column:${t}.${c}`, `referenced by eb43368 but not seen in the migrations (${u.sites[0]})`);
    }
    const tableChanges = changes.filter((ch) => ch.key === t || ch.key.startsWith(`${t}.`) || ch.table === t);
    for (const ch of tableChanges) {
      const col = ch.key.split('.')[1];
      if (['column-dropped', 'column-renamed', 'column-retyped'].includes(ch.kind) && (u.read.has(col) || u.write.has(col))) push('BREAKING', `column:${ch.key}`, `${ch.kind} in ${ch.file} and used by eb43368`);
      if (ch.kind === 'column-not-null' && !u.write.has(col) && (u.write.size || u.dynamicWrites.length)) {
        // Safe only if a new BEFORE INSERT trigger fills it (reviewed verdict required).
        const filler = changes.some((c) => c.kind === 'trigger-added' && c.table === t);
        push(filler ? 'REVIEW' : 'BREAKING', `column:${ch.key}`, `set NOT NULL in ${ch.file}; eb43368 inserts rows without it${filler ? ' (a new trigger on the table may fill it)' : ''}`);
      }
      if (ch.kind === 'table-renamed' || ch.kind === 'table-dropped') push('BREAKING', `table:${t}`, `${ch.kind} in ${ch.file}`);
    }
    // new constraints on columns eb43368 writes
    for (const [k, con] of after.schema.constraints) {
      if (con.table !== t || before.schema.constraints.get(k)?.expr === con.expr) continue;
      const cols = new Set((con.expr.match(/\b[a-z_][a-z0-9_]*\b/g) || []).filter((w) => ta.columns.has(w)));
      const writes = [...cols].filter((c) => u.write.has(c) || (u.dynamicWrites.length && tb && tb.columns.has(c)));
      if (writes.length) push('REVIEW', `constraint:${k}`, `${con.kind} added/changed in ${con.file} on column(s) eb43368 writes: ${writes.join(', ')}`);
      else push('OK', `constraint:${k}`, `${con.file}: only on columns eb43368 never writes (${[...cols].join(', ') || 'n/a'})`);
    }
    const isWritten = u.write.size > 0 || u.dynamicWrites.length > 0;
    const trig = [...after.schema.triggers.values()].filter((x) => x.table === t && tb && !before.schema.triggers.has([...after.schema.triggers.entries()].find(([, v]) => v === x)[0]));
    if (trig.length && isWritten) push('REVIEW', `trigger:${t}`, `new trigger(s) on a table eb43368 writes: ${trig.map((x) => x.file).join(', ')}`);
    // privileges for non-service-role clients: every read/insert/update a
    // user-scoped eb43368 client makes must be covered by the 075 re-grants.
    for (const [client, bc] of u.byClient) {
      if (!(/user|anon/i.test(client) || client === 'supabase')) continue;
      if (!after.schema.revokedFromAuthenticated.has(t)) continue; // never revoked: Supabase default grants apply
      const grants = [...after.schema.granted.keys()].filter((k) => k.startsWith(`${t}:`)).map((k) => k.slice(t.length + 1));
      const priv = (verb) => grants.map((g) => new RegExp(`(^|,\\s*)${verb}(\\s*\\(([^)]*)\\))?`, 'i').exec(g)).filter(Boolean)
        .map((mm) => (mm[3] ? new Set(mm[3].split(',').map((x) => x.trim().toLowerCase())) : 'ALL'));
      const covers = (verb, cols) => { const ps = priv(verb); return ps.includes('ALL') || [...cols].every((c) => ps.some((p) => p !== 'ALL' && p.has(c))); };
      const gaps = [];
      if (bc.select && !priv('select').length) gaps.push('SELECT');
      if (bc.insert.size && !covers('insert', bc.insert)) gaps.push(`INSERT(${[...bc.insert].join(',')})`);
      if (bc.update.size && !covers('update', bc.update)) gaps.push(`UPDATE(${[...bc.update].join(',')})`);
      if (bc.del && !priv('delete').length) gaps.push('DELETE');
      if (bc.dynamic) gaps.push('dynamic write (unverifiable)');
      push(gaps.length ? 'BREAKING' : 'OK', `grant:${t}:${client}`, gaps.length
        ? `user-scoped ${client} on ${t} needs ${gaps.join(', ')}, not covered by re-grants [${grants.join(' | ')}] after revoke in ${after.schema.revokedFromAuthenticated.get(t)}`
        : `user-scoped ${client} on ${t} (select=${bc.select} insert=${[...bc.insert].join(',') || '-'} update=${[...bc.update].join(',') || '-'}) is covered by re-grants [${grants.join(' | ')}] (revoke-all in ${after.schema.revokedFromAuthenticated.get(t)})`);
    }
  }
  return findings;
}

export function runCheck({ oldRev = 'eb43368', migrationsDir = path.join(ROOT, 'supabase', 'migrations') } = {}) {
  const before = replay(migrationsDir, { through: '046' });
  const after = replay(migrationsDir, { through: '075' });
  const delta = after.changes.filter((c) => c.file.slice(0, 3) > '046');
  const files = oldBackendFiles(oldRev).map((f) => ({ file: f, src: gitShow(oldRev, f) }));
  const usage = extractUsage(files);
  const findings = classify({ before, after, changes: delta, usage });
  const applied = readdirSync(migrationsDir).filter((f) => /^\d{3}_.+\.sql$/.test(f) && f.slice(0, 3) > '046' && f.slice(0, 3) <= '075').sort();
  return { oldRev, files: files.length, migrationsApplied: applied, usage, findings };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = process.argv.slice(2);
    const oldRev = args.includes('--old') ? args[args.indexOf('--old') + 1] : 'eb43368';
    const r = runCheck({ oldRev });
    if (args.includes('--json')) { console.log(JSON.stringify(r.findings, null, 2)); }
    else {
      console.log(`Rollback compatibility: ${oldRev} (${r.files} server-side files) against the schema after ${r.migrationsApplied.length} migrations (${r.migrationsApplied[0]} … ${r.migrationsApplied[r.migrationsApplied.length - 1]})`);
      console.log(`eb43368 touches ${r.usage.tables.size} tables and ${new Set(r.usage.rpcs.map((x) => x.fn)).size} RPCs.\n`);
      for (const lvl of ['BREAKING', 'REVIEW', 'UNRESOLVED', 'OK']) for (const f of r.findings.filter((x) => x.level === lvl)) console.log(`${lvl.padEnd(10)} ${f.key} — ${f.detail}${lvl === 'REVIEW' ? `\n           verdict: ${f.verdict || 'MISSING — review required'}` : ''}`);
    }
    const bad = r.findings.some((f) => f.level === 'BREAKING' || (f.level === 'REVIEW' && !f.verdict));
    process.exitCode = bad ? 2 : 0;
  } catch (e) { console.error(`error: ${e.message}`); process.exitCode = 1; }
}
