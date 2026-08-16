// Regression coverage for a real iPhone test finding (2026-08-08): the
// "Add trusted contact" modal screens (choose/from-phone/add, all
// presentation: "modal" in mobile/app/(tabs)/contacts/_layout.tsx) had no
// visible Back/Cancel control — iOS gives a native swipe-down-to-dismiss
// gesture for modals, but no header back button by default, and none of
// these screens added their own. A customer should never need to know
// that gesture to leave a screen.
//
// Static source checks, matching this repo's established pattern for
// React Native screens with no rendering harness (see
// tests/activation-screen-navigation.test.mjs) — confirms each screen
// actually renders <BackLink /> in every one of its states.
//
// Run with: node tests/contact-modal-navigation.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contactsDir = path.join(__dirname, '..', 'mobile', 'app', '(tabs)', 'contacts');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function backLinkCount(source) {
  return (source.match(/<BackLink\s*\/>/g) || []).length;
}

const chooseSource = readFileSync(path.join(contactsDir, 'choose.tsx'), 'utf8');
check(
  chooseSource.includes('import { BackLink }') && backLinkCount(chooseSource) === 1,
  'choose.tsx (the entry modal for "Add trusted contact") renders BackLink'
);

const addSource = readFileSync(path.join(contactsDir, 'add.tsx'), 'utf8');
check(
  addSource.includes('import { BackLink }') && backLinkCount(addSource) === 1,
  'add.tsx (manual entry, also reached via "Edit") renders BackLink'
);

const fromPhoneSource = readFileSync(path.join(contactsDir, 'from-phone.tsx'), 'utf8');
check(
  fromPhoneSource.includes('import { BackLink }') && backLinkCount(fromPhoneSource) === 3,
  `from-phone.tsx renders BackLink in all three of its states (intro, denied, list) — found ${backLinkCount(fromPhoneSource)}`
);

// The multi-select "list" state is the one explicitly reported stuck with
// only the iOS swipe gesture to escape — confirm it specifically, not
// just the intro screen before contacts are even loaded.
const listStateSource = fromPhoneSource.slice(fromPhoneSource.indexOf('// screenState === "list"'));
check(
  listStateSource.includes('<BackLink />'),
  'from-phone.tsx: the "Choose your trusted contacts" list screen specifically (not just the intro) has BackLink'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
