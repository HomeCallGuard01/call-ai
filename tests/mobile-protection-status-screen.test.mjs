// Regression coverage for the 5-step protection-status screen
// (2026-09-27, launch hardening) — mobile/app/(setup)/protection-status.tsx
// and its Home-tab link. Same convention as the rest of this project (no
// RN test tooling): screens are checked as source.
//
// Run with: node tests/mobile-protection-status-screen.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.join(__dirname, '..', 'mobile');
const screenSrc = readFileSync(path.join(mobileRoot, 'app', '(setup)', 'protection-status.tsx'), 'utf8');
const homeSrc = readFileSync(path.join(mobileRoot, 'app', '(tabs)', 'index.tsx'), 'utf8');
const typesSrc = readFileSync(path.join(mobileRoot, 'lib', 'types.ts'), 'utf8');

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- the screen reads the real dashboard response, no separate/new backend call ---
check(
  /import\s*{\s*fetchDashboard\s*}\s*from\s*"\.\.\/\.\.\/lib\/api"/.test(screenSrc),
  'the screen fetches data via the existing fetchDashboard — no new/competing verification endpoint'
);
check(
  /data\.protection\.steps/.test(screenSrc) && /data\.protection\.guidance/.test(screenSrc),
  'the screen reads protection.steps/protection.guidance directly from the dashboard response'
);

// --- renders all 5 steps from server data, never hardcodes step content ---
check(
  /steps\.map\(/.test(screenSrc),
  'steps are rendered by mapping the server-supplied array, not a hardcoded local list'
);
// Checked against the render body only (past the header comment block),
// as quoted string literals specifically — not comment prose explaining
// what the server-supplied labels happen to say.
{
  const renderBody = screenSrc.slice(screenSrc.indexOf('export default function'));
  check(
    !/"HCG number active"|"Call forwarding detected"|"Home Call Guard app ready"|"Call delivery confirmed"|"Protection Active"/.test(renderBody),
    'the screen never hardcodes any step label as a string literal in its render code — all 5 labels come from the server (services/customerProtectionSteps.js), so wording only ever needs to change in one place'
  );
}

// --- no internal jargon ever appears on this screen ---
check(
  !/\bTwilio\b|\bVoice SDK\b|\bwebhook\b|\bcall leg\b|\bmedia.?stream\b/i.test(screenSrc),
  'the screen source contains no internal architecture jargon (Twilio, Voice SDK, webhook, call leg, media stream) — matches "customers should NOT need to understand" the underlying architecture'
);

// --- the guidance banner is optional/conditional, never a hardcoded permanent message ---
check(
  /\{guidance\s*&&/.test(screenSrc),
  'the guidance banner only renders when guidance is present — silently absent once fully protected, not a leftover message'
);

// --- types: ProtectionStep/ProtectionGuidance exist and DashboardResponse carries them ---
check(
  /export interface ProtectionStep/.test(typesSrc) && /export interface ProtectionGuidance/.test(typesSrc),
  'ProtectionStep/ProtectionGuidance types are defined'
);
check(
  /steps: ProtectionStep\[\];/.test(typesSrc) && /guidance: ProtectionGuidance \| null;/.test(typesSrc),
  'DashboardResponse.protection carries steps/guidance with the correct types'
);

// --- Home tab: reachable from Home, addressing "reachable from Home" ---
check(
  /router\.push\("\/\(setup\)\/protection-status"\)/.test(homeSrc),
  'the Home tab links to the new protection-status screen'
);
// The link must appear unconditionally (outside every homeProtectionState
// branch) so it's reachable regardless of which state the household is
// currently in — not just once already fully protected.
{
  const lastBranchEnd = homeSrc.lastIndexOf('homeProtectionState ===');
  const linkIndex = homeSrc.indexOf('protection-status');
  check(
    linkIndex > lastBranchEnd,
    'the "View protection status" link sits after every homeProtectionState-conditional block — reachable in every state, not gated behind already being fully protected'
  );
}

console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} mobile-protection-status-screen checks ${failures === 0 ? 'passed' : 'FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;
