// React/network binding for the landline "Coming soon" state. All decisions
// live in lib/landlineAvailability.ts (pure, fail-closed); this file only
// connects that store to GET /api/v1/launch-flags (lib/api.ts) and to React.
import { useEffect, useState } from "react";
import { fetchLaunchFlags } from "./api";
import { createLandlineFlagStore } from "./landlineAvailability";

// One shared store for the whole app, so every screen agrees and the
// launch-flags request is made once and reused (not once per screen).
export const landlineFlagStore = createLandlineFlagStore({ fetchFlags: fetchLaunchFlags });

// Synchronous read for event handlers (e.g. the purchase-time guard in
// Subscribe). True only for the landline device type while the server says
// Coming soon — and while the answer is not yet known, which is the same thing.
export function isLandlineComingSoon(deviceType?: string | null): boolean {
  return deviceType === "landline" && landlineFlagStore.get();
}

export function refreshLandlineComingSoon(force?: boolean): Promise<boolean> {
  return landlineFlagStore.refresh(force);
}

// True (Coming soon) until the server explicitly says landline is open. Every
// screen that shows or gates landline calls this once at the top.
export function useLandlineComingSoon(): boolean {
  const [comingSoon, setComingSoon] = useState<boolean>(landlineFlagStore.get());

  useEffect(() => {
    let active = true;
    const unsubscribe = landlineFlagStore.subscribe(value => {
      if (active) setComingSoon(value);
    });
    landlineFlagStore.refresh().then(value => {
      if (active) setComingSoon(value);
    });
    setComingSoon(landlineFlagStore.get());
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return comingSoon;
}
