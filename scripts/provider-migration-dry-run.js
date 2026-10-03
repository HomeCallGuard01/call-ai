#!/usr/bin/env node
// Provider-migration DRY RUN. Reads a local JSON snapshot and prints, per
// customer, what moving to --target would involve. It has no database or
// provider client at all: it cannot change a number, a route, a
// subscription or a row, by construction.
//
// Usage:
//   node scripts/provider-migration-dry-run.js \
//     --snapshot=path/to/snapshot.json --target=telnyx \
//     [--strategy=port_preferred|replace_only] \
//     [--portability=path/to/portability.json]   {"+44...": "portable" | "not_portable" | "unknown"}
//     [--target-port-in=true|false|unknown] \
//     [--format=table|json] [--show-numbers]
//
// Snapshot shape: { "households": [{ id, account_number, status,
// device_type, activation_verified_at }], "assignments": [routing_assignments rows] }
// — see docs/architecture/CUSTOMER_IDENTITY_AND_CARRIER_ABSTRACTION.md for
// the read-only query that produces one. Numbers are masked unless
// --show-numbers is given.

'use strict';

const fs = require('node:fs');
const { planProviderMigration } = require('../services/customerIdentity/providerMigrationPlanner');

const REFUSED_FLAGS = ['--execute', '--apply', '--commit', '--live', '--write'];

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (REFUSED_FLAGS.some(f => raw === f || raw.startsWith(`${f}=`))) {
      throw new Error(`${raw} refused: this tool is dry-run only and has no way to act on a provider or database`);
    }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(raw);
    if (!m) throw new Error(`Unrecognised argument: ${raw}`);
    args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function portInCapability(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

const COLUMNS = [
  ['accountNumber', 'Account'],
  ['currentProvider', 'Provider'],
  ['currentNumber', 'Number'],
  ['targetProvider', 'Target'],
  ['plan', 'Plan'],
  ['portState', 'Port'],
  ['replacementState', 'Replacement'],
  ['forwardingAction', 'Forwarding'],
  ['verificationStatus', 'Verification'],
  ['rollbackState', 'Rollback'],
];

function renderTable(report) {
  const rows = report.rows.map(r => COLUMNS.map(([k]) => String(r[k] ?? '—')));
  const widths = COLUMNS.map(([, h], i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = cells => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  const out = [
    `DRY RUN — target ${report.targetProvider}, strategy ${report.strategy}. Nothing was changed.`,
    '',
    line(COLUMNS.map(([, h]) => h)),
    line(widths.map(w => '-'.repeat(w))),
    ...rows.map(line),
    '',
    `Customers: ${report.summary.customers}`,
    `By plan: ${JSON.stringify(report.summary.byPlan)}`,
    `Customers needing a forwarding change: ${report.summary.customersNeedingForwardingChange}`,
    `Numbers held by more than one household: ${report.summary.numbersHeldByMultipleHouseholds}`,
  ];
  for (const r of report.rows.filter(x => x.notes.length)) {
    out.push(`  ${r.accountNumber || r.householdId}: ${r.notes.join(', ')}`);
  }
  return out.join('\n');
}

function run(argv, { stdout = process.stdout } = {}) {
  const args = parseArgs(argv);
  if (!args.snapshot || !args.target) {
    throw new Error('--snapshot=<file> and --target=<provider code> are required');
  }
  const report = planProviderMigration(readJson(args.snapshot), {
    targetProvider: args.target,
    strategy: args.strategy,
    portability: args.portability ? readJson(args.portability) : {},
    targetCapabilities: { portIn: portInCapability(args['target-port-in']) },
    showNumbers: args['show-numbers'] === true,
  });
  stdout.write(args.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : `${renderTable(report)}\n`);
  return report;
}

if (require.main === module) {
  try {
    run(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { run, parseArgs };
