const { normaliseNumber } = require("./phone");

// Comfortably above the ~2,000 device contacts this must support — a
// sanity/DoS ceiling, not a real expected limit (unlike server.js's
// /upload-contacts MAX_CONTACTS_PER_UPLOAD=500, which exists to catch an
// obviously-wrong CSV file, a judgment call that doesn't apply to a real
// device address book).
const MAX_SYNC_CONTACTS = 2500;

// Pure — see tests/contacts-sync.test.mjs. Same dedup approach as
// server.js's /upload-contacts and the single-contact add/edit routes
// (routes/mobileApi.js): normalise every candidate number, then skip
// anything already known — both already saved for this household, and
// duplicated within the same batch. Never updates or removes an existing
// contact; a name change or a contact that's vanished from the phone is
// left exactly as it is (V1 syncs additions only).
function buildSyncPlan(rawContacts, existingContacts) {
  const validContacts = rawContacts
    .map(c => ({
      name: (c && c.name ? String(c.name).trim() : "") || "Unnamed contact",
      number: normaliseNumber(c && c.number),
    }))
    .filter(c => c.number.length === 10);

  const seen = new Set(existingContacts.map(c => normaliseNumber(c.number)));
  const toInsert = [];
  let skippedDuplicates = 0;

  for (const c of validContacts) {
    if (seen.has(c.number)) {
      skippedDuplicates++;
      continue;
    }
    seen.add(c.number);
    toInsert.push({ name: c.name, number: c.number, customer_id: null });
  }

  return { toInsert, skippedDuplicates };
}

// Pure — the three exact wordings a sync can end in, so the mobile app
// never has to re-derive pluralisation/phrasing itself.
function buildSyncResultMessage(added, skippedDuplicates) {
  if (added === 0) {
    return "Your contacts are already up to date.";
  }
  if (skippedDuplicates === 0) {
    return `${added} contact${added === 1 ? "" : "s"} synced.`;
  }
  return `${added} new contact${added === 1 ? "" : "s"} added. ${skippedDuplicates} ${skippedDuplicates === 1 ? "was" : "were"} already synced.`;
}

module.exports = { MAX_SYNC_CONTACTS, buildSyncPlan, buildSyncResultMessage };
