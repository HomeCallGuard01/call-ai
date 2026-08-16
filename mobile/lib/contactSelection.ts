// Pure logic extracted from app/(tabs)/contacts/from-phone.tsx and
// app/(setup)/contacts.tsx so it's directly unit testable
// (tests/mobile-app.test.mjs) without expo-contacts or any native module
// involved.

export interface PickedContact {
  key: string;
  name: string;
  number: string;
}

export interface PickedPhoneNumber {
  label?: string | null;
  number?: string | null;
}

// Never adds a contact that has no phone number, and never adds the same
// number twice even if picked again (e.g. the same contact chosen twice
// by mistake) — dedupes on number, not name, since two different device
// contacts could coincidentally share a display name.
export function addPickedContact(
  existing: PickedContact[],
  name: string,
  number: string,
  makeKey: () => string = () => `${Date.now()}-${number}`
): PickedContact[] {
  if (!number) return existing;
  if (existing.some(c => c.number === number)) return existing;
  return [...existing, { key: makeKey(), name, number }];
}

export function removePickedContact(existing: PickedContact[], key: string): PickedContact[] {
  return existing.filter(c => c.key !== key);
}

// A device contact's phoneNumbers list can be empty (nothing to add —
// caller should show a "no phone number" message and add nothing) or
// have entries with a missing `number` field (malformed data some
// contact sources produce) — those are filtered out, never passed
// through as a fake empty-string phone number.
export function usableNumbers(phoneNumbers: PickedPhoneNumber[] | undefined | null): PickedPhoneNumber[] {
  return (phoneNumbers || []).filter((p): p is { label?: string | null; number: string } => !!p.number);
}

// Lightweight client-side shape check, mirroring the backend's own
// normaliseNumber (services/phone.js: strip non-digits, take the last 10)
// closely enough to catch an obviously-malformed number at the moment of
// manual entry rather than only after a full round trip to the server at
// save time — the delayed, generic "that number doesn't look right"
// error was a real, confusing gap: a customer would type a typo'd number
// into the form, tap Add, see it sitting in the list looking fine, and
// only find out something was wrong on Continue, with no clue which of
// several contacts was the problem. Deliberately permissive beyond the
// core "does this look like a phone number" check — the backend remains
// the actual authority, this only exists to give faster feedback for the
// unambiguous case (letters, too short, empty).
export function looksLikePhoneNumber(value: string): boolean {
  const digitsOnly = value.replace(/\D/g, "");
  return digitsOnly.length >= 10;
}

// Per-contact outcome of a batch save attempt (lib/api.ts's addContact
// per PickedContact), keyed by the contact's own stable `key` — never by
// name-prefix string matching, which misclassifies contacts where one
// name is a prefix of another (e.g. "Jo" and "Jo Smith" both produce
// failure messages starting with "Jo").
export type SaveOutcome = "saved" | "duplicate" | "invalid" | "failed";

export interface SaveResult {
  key: string;
  name: string;
  outcome: SaveOutcome;
}

// Decides which contacts should remain in the "still needs saving" list
// after a batch attempt. A "duplicate" result means the contact is
// already genuinely trusted server-side under a different action — that
// is a real, complete outcome, not a failure to retry, so it's removed
// from the list exactly like a fresh save success. Only genuine failures
// (invalid input, or an unexpected error) stay, so the customer can see
// and retry exactly what didn't work — never a contact that's already
// safely saved either way.
export function contactsStillNeedingSave(results: SaveResult[]): string[] {
  return results.filter(r => r.outcome === "invalid" || r.outcome === "failed").map(r => r.key);
}

export function describeSaveFailure(result: SaveResult): string {
  if (result.outcome === "invalid") return `${result.name} — that number doesn't look right`;
  return `${result.name} — couldn't be saved`;
}

// --- Multi-select "Choose from my iPhone/Android contacts" (2026-08-08) ---
//
// Replaces the earlier one-at-a-time presentContactPickerAsync() loop for
// the *primary* iPhone/Android flow: after Contacts.requestPermissionsAsync()
// + Contacts.getContactsAsync(), the raw device contact list is shaped by
// buildSelectableContacts() into what this screen renders as an in-app,
// on-device checklist — the customer ticks several people in one screen,
// then Save sends only the ticked ones. The full device list this builds
// from never leaves the device; only the subset a customer explicitly
// selects (tracked by toggleContactSelection) is ever handed to addContact.

export interface DeviceContact {
  id?: string | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phoneNumbers?: PickedPhoneNumber[] | null;
}

export interface SelectableContact {
  id: string;
  name: string;
  number: string;
}

// A contact with more than one usable number uses the first one for its
// list row here — asking "which number?" per row during a fast bulk
// browse would defeat the point of a one-screen multi-select; a customer
// who specifically needs a different one of several numbers can still
// use "Enter manually". Contacts with zero usable numbers, or missing a
// device-assigned id entirely, are left out rather than shown as an
// unselectable dead row. Sorted by name so the list reads like a normal
// contacts app, not device-insertion order.
export function buildSelectableContacts(deviceContacts: DeviceContact[] | undefined | null): SelectableContact[] {
  const withNumbers = (deviceContacts || [])
    .map((c): SelectableContact | null => {
      if (!c.id) return null;
      const numbers = usableNumbers(c.phoneNumbers);
      if (numbers.length === 0) return null;
      const name =
        (c.name && c.name.trim()) ||
        [c.firstName, c.lastName].filter(Boolean).join(" ").trim() ||
        "Unnamed contact";
      return { id: c.id, name, number: numbers[0].number! };
    })
    .filter((c): c is SelectableContact => c !== null);

  return withNumbers.sort((a, b) => a.name.localeCompare(b.name));
}

// Pure toggle for a multi-select-by-id list — ticking an already-ticked
// row removes it, matching standard checklist/checkbox behaviour.
export function toggleContactSelection(selectedIds: string[], id: string): string[] {
  return selectedIds.includes(id) ? selectedIds.filter(existing => existing !== id) : [...selectedIds, id];
}
