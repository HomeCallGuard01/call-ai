// Landline availability in the mobile app — pure logic, no React, no network
// imports (so it can be executed directly by tests/mobile-landline-coming-soon.test.mjs).
//
// The BACKEND flag is authoritative (LANDLINE_COMING_SOON in
// services/featureFlags.js, published as `landlineComingSoon` by
// GET /api/v1/launch-flags, and enforced server-side at every checkout gate).
// The app holds NO independent availability decision of its own. It follows
// the server, and it FAILS CLOSED:
//
//   Landline is treated as available ONLY when a launch-flags response
//   explicitly contains `landlineComingSoon === false` (boolean false).
//   Everything else — request failed, timed out, non-2xx, malformed JSON, an
//   older server that doesn't send the field, "false" as a string, null, a
//   missing body — keeps landline "Coming soon".
//
// "Coming soon" means the same thing everywhere it is shown: the Landline
// device-picker card stays (clearly marked) but leads to a dead end, and
// Subscribe / Activate / Account -> Set up call forwarding refuse to proceed
// with a landline device. Turn off protection is deliberately never gated
// (see app/(tabs)/account/turn-off-protection.tsx): a household that already
// diverted a landline must always be able to see its cancel code.
//
// The landline provider list, setHouseholdLandline and the provider-specific
// activation plumbing are all kept; they are simply unreachable while the
// server says "coming soon".

export const LANDLINE_CARD_LABEL_AVAILABLE = "Landline";
export const LANDLINE_CARD_LABEL_COMING_SOON = "Landline — Coming soon";

export const LANDLINE_COMING_SOON_TITLE = "Home Call Guard for landline is coming soon";

export const LANDLINE_COMING_SOON_BODY =
  "Landline support isn't available yet, so we can't set up or take payment for a landline at the moment.\n\nHome Call Guard is available now for Android phones.";

// The single fail-closed rule. Returns false ("landline is open") only for an
// object whose landlineComingSoon is exactly the boolean false.
export function resolveLandlineComingSoon(flags: unknown): boolean {
  if (flags !== null && typeof flags === "object" && (flags as { landlineComingSoon?: unknown }).landlineComingSoon === false) {
    return false;
  }
  return true;
}

export interface LandlineFlagStoreOptions {
  fetchFlags: () => Promise<unknown>;
  // A launch-flags request that hasn't answered by this point counts as a
  // failure (=> Coming soon), so a hung connection can never leave landline
  // open, and never leaves the store waiting forever either.
  timeoutMs?: number;
  // How long a successful answer is reused before the next refresh re-asks.
  ttlMs?: number;
  now?: () => number;
}

export interface LandlineFlagStore {
  // Current best knowledge. Starts true (Coming soon) and only ever becomes
  // false after a successful, explicit landlineComingSoon === false answer.
  get(): boolean;
  refresh(force?: boolean): Promise<boolean>;
  subscribe(listener: (comingSoon: boolean) => void): () => void;
}

export function createLandlineFlagStore(options: LandlineFlagStoreOptions): LandlineFlagStore {
  const timeoutMs = options.timeoutMs ?? 8000;
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  const now = options.now ?? Date.now;

  let comingSoon = true; // fail closed until the server explicitly says otherwise
  let fetchedAt = 0; // 0 = no successful answer currently held
  let inflight: Promise<boolean> | null = null;
  const listeners = new Set<(value: boolean) => void>();

  function set(value: boolean) {
    if (value === comingSoon) return;
    comingSoon = value;
    listeners.forEach(listener => listener(value));
  }

  function refresh(force = false): Promise<boolean> {
    if (inflight) return inflight;
    if (!force && fetchedAt !== 0 && now() - fetchedAt < ttlMs) return Promise.resolve(comingSoon);

    inflight = new Promise<boolean>(resolve => {
      let settled = false;

      const failClosed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fetchedAt = 0;
        set(true);
        resolve(true);
      };

      const timer = setTimeout(failClosed, timeoutMs);

      Promise.resolve()
        .then(() => options.fetchFlags())
        .then(flags => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const value = resolveLandlineComingSoon(flags);
          fetchedAt = now();
          set(value);
          resolve(value);
        }, failClosed);
    }).finally(() => {
      inflight = null;
    });

    return inflight;
  }

  return {
    get: () => comingSoon,
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
