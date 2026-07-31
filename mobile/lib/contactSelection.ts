// Pure logic extracted from app/(tabs)/contacts/from-phone.tsx so it's
// directly unit testable (tests/mobile-contact-selection.test.mjs)
// without expo-contacts or any native module involved.

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
