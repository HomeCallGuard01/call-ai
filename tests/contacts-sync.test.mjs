// Unit tests for services/contactsSync.js — the "Sync contacts" bulk
// import (2026-08-2X). Pure functions, no network/Twilio/Supabase
// involved. Run with: node tests/contacts-sync.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MAX_SYNC_CONTACTS, buildSyncPlan, buildSyncResultMessage } = require('../services/contactsSync.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- buildSyncPlan: first sync, nothing existing yet ---

{
  const device = [
    { name: 'Oyvind Aamodt', number: '07700900001' },
    { name: 'Mia', number: '07700 900 002' },
    { name: 'International Friend', number: '+1 212 555 0147' }, // reduces to a 10-digit tail either way
  ];
  const { toInsert, skippedDuplicates } = buildSyncPlan(device, []);
  check(toInsert.length === 3, `first sync with no existing contacts inserts every valid one (got ${toInsert.length})`);
  check(skippedDuplicates === 0, 'first sync with no existing contacts skips nothing');
  check(toInsert[0].number === '7700900001', 'numbers are normalised (spaces stripped)');
}

// --- buildSyncPlan: contacts with no usable number are silently dropped ---

{
  const device = [
    { name: 'No Number', number: '' },
    { name: 'Too Short', number: '12345' },
    { name: 'Valid', number: '07700900003' },
  ];
  const { toInsert } = buildSyncPlan(device, []);
  check(toInsert.length === 1 && toInsert[0].name === 'Valid', 'contacts with no usable/valid number are silently skipped, not errors');
}

// --- buildSyncPlan: dedup against already-known contacts (repeat sync) ---

{
  const device = [
    { name: 'Oyvind Aamodt', number: '07700900001' }, // already known
    { name: 'Mia', number: '07700900002' }, // new this time
  ];
  const existing = [{ id: '1', name: 'Oyvind Aamodt', number: '7700900001' }];
  const { toInsert, skippedDuplicates } = buildSyncPlan(device, existing);
  check(toInsert.length === 1 && toInsert[0].name === 'Mia', 'repeat sync only inserts the genuinely new contact');
  check(skippedDuplicates === 1, 'repeat sync counts the already-known contact as a skipped duplicate');
}

// --- buildSyncPlan: dedup within the same batch too (not just against existing) ---

{
  const device = [
    { name: 'Same Person, Home', number: '07700900004' },
    { name: 'Same Person, Mobile (same number, different label)', number: '07700 900 004' },
  ];
  const { toInsert, skippedDuplicates } = buildSyncPlan(device, []);
  check(toInsert.length === 1, 'two device entries with the same normalised number only insert once');
  check(skippedDuplicates === 1, 'the second, in-batch duplicate is counted as skipped');
}

// --- buildSyncPlan: re-running the exact same sync twice is fully idempotent ---

{
  const device = [
    { name: 'Oyvind Aamodt', number: '07700900001' },
    { name: 'Mia', number: '07700900002' },
  ];
  const first = buildSyncPlan(device, []);
  check(first.toInsert.length === 2, 'idempotency check: first run inserts both');

  // Simulate the DB now containing what the first run inserted.
  const afterFirstRun = first.toInsert.map(c => ({ id: c.number, name: c.name, number: c.number }));
  const second = buildSyncPlan(device, afterFirstRun);
  check(second.toInsert.length === 0, 'idempotency check: re-running the identical sync inserts nothing new');
  check(second.skippedDuplicates === 2, 'idempotency check: both are correctly recognised as already synced');
}

// --- buildSyncPlan: missing/malformed device contact entries never throw ---

{
  const device = [null, undefined, {}, { name: 'No number field' }, { number: '07700900005' }];
  let threw = false;
  let toInsert = [];
  try {
    ({ toInsert } = buildSyncPlan(device, []));
  } catch {
    threw = true;
  }
  check(!threw, 'malformed/missing device contact entries never throw');
  check(toInsert.length === 1 && toInsert[0].name === 'Unnamed contact', 'a contact with a number but no name falls back to "Unnamed contact"');
}

// --- buildSyncResultMessage: the three exact required wordings ---

{
  check(buildSyncResultMessage(684, 0) === '684 contacts synced.', 'first-sync wording matches exactly: "684 contacts synced."');
  check(buildSyncResultMessage(12, 672) === '12 new contacts added. 672 were already synced.', 'repeat-sync wording matches exactly');
  check(buildSyncResultMessage(0, 700) === 'Your contacts are already up to date.', 'nothing-new wording matches exactly');
  check(buildSyncResultMessage(0, 0) === 'Your contacts are already up to date.', 'zero valid contacts at all also reads as "up to date", not an error');
  check(buildSyncResultMessage(1, 0) === '1 contact synced.', 'singular wording: "1 contact synced."');
  check(buildSyncResultMessage(1, 1) === '1 new contact added. 1 was already synced.', 'singular wording on both sides of the repeat-sync message');
}

// --- MAX_SYNC_CONTACTS supports at least 2,000 device contacts ---

{
  check(MAX_SYNC_CONTACTS >= 2000, `MAX_SYNC_CONTACTS (${MAX_SYNC_CONTACTS}) supports at least 2,000 device contacts`);
}

{
  // A ~2,000-contact sync completes correctly and efficiently (one pass,
  // one Set) — not a performance benchmark, just proof it doesn't choke.
  const device = Array.from({ length: 2000 }, (_, i) => ({
    name: `Contact ${i}`,
    number: `07${String(700000000 + i).padStart(9, '0')}`,
  }));
  const { toInsert, skippedDuplicates } = buildSyncPlan(device, []);
  check(toInsert.length === 2000, 'a 2,000-contact batch inserts all 2,000 when none are duplicates');
  check(skippedDuplicates === 0, 'a 2,000-contact batch with no duplicates skips none');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
