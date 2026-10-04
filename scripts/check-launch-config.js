#!/usr/bin/env node
// Prints the launch-required configuration verdict for the CURRENT
// environment (services/config/launchConfig.js) without starting the server.
// Key names, levels and problem codes only — never values. Exit 1 if the
// server would refuse to start. Usage (e.g. in a staging shell):
//   HCG_DEPLOYMENT=staging node scripts/check-launch-config.js
'use strict';
require('dotenv').config();
const { evaluateLaunchConfig, OPTIONAL_GROUPS } = require('../services/config/launchConfig');
const r = evaluateLaunchConfig(process.env);
console.log(`deployment: ${r.deployment} (detected ${r.detected}${r.declared ? `, declared ${r.declared}` : ''})`);
for (const row of r.rows) console.log(`${row.problem ? (row.level === 'required' || row.level === 'forbidden' ? 'FATAL' : row.level === 'recommended' ? 'WARN ' : 'ok*  ') : 'ok   '}  ${row.level.padEnd(11)} ${row.id.padEnd(36)} ${row.keys.join(', ')}${row.problem ? `  → ${row.problem}` : ''}`);
for (const a of r.acknowledgedFatal) console.log(`ACKNOWLEDGED UNSAFE: ${a.id}`);
if (process.argv.includes('--groups')) for (const [g, keys] of Object.entries(OPTIONAL_GROUPS)) console.log(`\n${g}:\n  ${keys.join('\n  ')}`);
console.log(r.ok ? '\nwould START' : `\nwould REFUSE TO START (${r.fatal.length} fatal)`);
process.exitCode = r.ok ? 0 : 1;
