// Static CSS/markup assertions for the Trusted Contacts row's narrow-screen
// behaviour (Stage 3 mobile hardening). No real browser/viewport tool is
// available in this environment, so this checks the actual rules/markup
// that determine the layout rather than a rendered screenshot — real-device
// visual confirmation is still recommended before launch.
//
// Run with: node tests/trusted-contacts-mobile-layout.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'upload.html'), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function ruleBody(selector) {
  const idx = html.indexOf(selector + ' {');
  if (idx === -1) return null;
  const end = html.indexOf('}', idx);
  return html.slice(idx, end);
}

// --- markup: name/number and the two action buttons are each in their
// own container, not loose siblings, so CSS can address them as a group ---

check(
  html.includes('<div class="contact-details">'),
  'renderTrustedContacts wraps name/number in a .contact-details container'
);

check(
  html.includes('<div class="contact-actions">'),
  'renderTrustedContacts wraps Edit and Delete in a .contact-actions container'
);

check(
  /<div class="contact-actions">[\s\S]*?contact-edit-button[\s\S]*?contact-delete-button[\s\S]*?<\/div>/.test(html),
  'Edit appears before Delete inside .contact-actions'
);

// --- long content can't force the row wider than its container ---

const detailsRule = ruleBody('.contact-details');
check(!!detailsRule && /min-width:\s*0/.test(detailsRule), '.contact-details overrides flex\'s default min-width so it can shrink below its content width');
check(!!detailsRule && /overflow-wrap:\s*anywhere/.test(detailsRule), '.contact-details lets a long name/number wrap internally rather than overflow');

// --- narrow-width behaviour: Edit/Delete move to their own row, not
// crammed alongside name/number (covers the 768px breakpoint, which
// includes the 320/375/430px widths this check targets) ---

const mediaStart = html.indexOf('@media (max-width: 768px)');
const mediaEnd = html.indexOf('@media (max-width: 420px)');
const narrowBlock = mediaStart !== -1 && mediaEnd !== -1 ? html.slice(mediaStart, mediaEnd) : '';

check(narrowBlock.length > 0, 'the existing @media (max-width: 768px) block exists and was found');
check(/\.contact-item\s*\{[^}]*flex-wrap:\s*wrap/.test(narrowBlock), 'narrow widths: .contact-item allows wrapping instead of forcing everything onto one cramped row');
check(/\.contact-actions\s*\{[^}]*flex-basis:\s*100%/.test(narrowBlock), 'narrow widths: .contact-actions is forced onto its own full-width row below name/number');

// --- Delete is visually secondary, not just functionally guarded ---

const deleteButtonRule = ruleBody('.contact-delete-button');
check(!!deleteButtonRule, '.contact-delete-button has its own style rule, distinct from the shared secondary-action-button base');
check(
  html.includes('window.confirm('),
  'a confirm() prompt still guards every delete (functional safeguard, unchanged from Stage 3)'
);

// --- Delete/Edit both still use the existing touch-friendly button base
// (same padding as every other button on this page) rather than a new,
// smaller/unverified touch target ---

check(
  /contact-edit-button/.test(html) && /secondary-action-button contact-edit-button/.test(html),
  'Edit reuses the existing .secondary-action-button base (same padding/touch target as the rest of the page)'
);
check(
  /secondary-action-button contact-delete-button/.test(html),
  'Delete reuses the existing .secondary-action-button base (same padding/touch target as the rest of the page)'
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll trusted-contacts mobile-layout checks passed.');
}
