// Connects lib/iphoneAvailability.ts to GET /api/v1/launch-flags and React
// (2026-09-30, iOS technical parity). Same store mechanics as
// lib/landlineFlag.ts (fail closed, 8 s timeout, 5 min cache).
import { useEffect, useState } from "react";
import { fetchLaunchFlags } from "./api";
import { createLandlineFlagStore } from "./landlineAvailability";
import { resolveIosComingSoon } from "./iphoneAvailability";

export const iosComingSoonStore = createLandlineFlagStore({ fetchFlags: fetchLaunchFlags, resolve: resolveIosComingSoon });

export function refreshIosComingSoon(force?: boolean): Promise<boolean> {
  return iosComingSoonStore.refresh(force);
}

export function useIosComingSoon(): boolean {
  const [comingSoon, setComingSoon] = useState<boolean>(iosComingSoonStore.get());
  useEffect(() => {
    let active = true;
    const unsubscribe = iosComingSoonStore.subscribe(value => {
      if (active) setComingSoon(value);
    });
    iosComingSoonStore.refresh().then(value => {
      if (active) setComingSoon(value);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return comingSoon;
}
