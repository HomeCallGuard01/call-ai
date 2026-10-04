// MI-2b (final UI integration 2026-10-04): ONE protection vocabulary shared
// by the admin Control Centre and the 1.0.2 apps. Both read the server's
// canonical codes (services/lifecycle/activationState.js STAGES and
// PROTECTION_GATES); this pins that neither side invents or drops one, so
// "Protected" means the same thing on every surface. Copy stays owned by
// each surface (admin wording vs customer wording, decision D-C5).
//
// Run with: node tests/protection-vocabulary-parity.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'x';

const { STAGES, PROTECTION_GATES } = require('../services/lifecycle/activationState.js');
const { STAGE_DISPLAY, BLOCKER_TEXT } = require('../services/adminControlCentre/summary.js');
const viewSrc = readFileSync(path.join(__dirname, '..', 'mobile', 'lib', 'protectionView.ts'), 'utf8');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const stageCodes = Object.values(STAGES);
const gates = [...PROTECTION_GATES];

check(stageCodes.every((s) => STAGE_DISPLAY[s] && STAGE_DISPLAY[s].label), 'admin: every canonical stage has an admin label');
check(Object.keys(STAGE_DISPLAY).every((s) => stageCodes.includes(s)), 'admin: no admin stage label for a stage the server never produces');
check(gates.every((g) => BLOCKER_TEXT[g]) && Object.keys(BLOCKER_TEXT).every((g) => gates.includes(g)), 'admin: blocker wording covers exactly the canonical protection gates');

const stepBlock = viewSrc.slice(viewSrc.indexOf('const STEP_GATES'), viewSrc.indexOf('export function buildSetupChecklist'));
const appGates = [...stepBlock.matchAll(/gates: \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([A-Za-z]+)"/g)].map((x) => x[1]));
check(appGates.length > 0 && appGates.every((g) => gates.includes(g)), `app: every checklist step reads a real canonical gate (${appGates.join(', ')})`);
const customerGates = gates.filter((g) => !['accountActive', 'stateKnown'].includes(g));
check(customerGates.every((g) => appGates.includes(g)), 'app: every customer-actionable gate is shown as a checklist step (none silently dropped)');
const unknownBlock = viewSrc.match(/STATE_UNKNOWN_BLOCKERS = \[([^\]]*)\]/);
check(unknownBlock && /"stateKnown"/.test(unknownBlock[1]) && /"accountActive"/.test(unknownBlock[1]), 'app: the two non-actionable gates make the state "unknown", never a false tick');
check(/activationStage === "protected" && p\.protectionBlockers!\.length === 0/.test(viewSrc) && STAGES.PROTECTED === 'protected', 'app: "protected" = the server stage "protected" with zero blockers — the admin "Protected" label maps to the same stage');
const unknownStages = viewSrc.match(/UNKNOWN_STAGES = new Set\(\[([^\]]*)\]\)/);
check(unknownStages && /"ambiguous"/.test(unknownStages[1]) && stageCodes.includes('ambiguous') && /"account_deleted"/.test(unknownStages[1]) && stageCodes.includes('account_deleted'), 'app: unknown-stage codes match canonical stage codes');

console.log(failures === 0 ? '\nProtection vocabulary parity: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
