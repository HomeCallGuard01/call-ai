// Install attribution (2026-09-29 prototype) — which website campaign an
// Android install came from, sent once with registration. See
// services/playInstallReferrer.js for the full design and privacy scope.
//
// Android only: reads Google Play's Install Referrer via expo-application
// (already a dependency — no new native module, no third-party SDK). The
// parsed UTM fields are cached in SecureStore so a later registration (the
// customer may not sign up on first launch) still carries them. Never
// throws: attribution must never affect sign-up.
import { Platform } from "react-native";
import * as Application from "expo-application";
import * as SecureStore from "expo-secure-store";
import { parseInstallReferrer, type InstallAttribution } from "./installReferrerParse";

const STORAGE_KEY = "hcg_install_attribution_v1";

export async function getInstallAttribution(): Promise<InstallAttribution | null> {
  if (Platform.OS !== "android") return null;
  try {
    const cached = await SecureStore.getItemAsync(STORAGE_KEY);
    if (cached) return JSON.parse(cached) as InstallAttribution;
  } catch {
    // fall through and re-read from Play
  }
  try {
    const parsed = parseInstallReferrer(await Application.getInstallReferrerAsync());
    if (parsed) {
      try {
        await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(parsed));
      } catch {
        // caching is a convenience only
      }
    }
    return parsed;
  } catch {
    return null;
  }
}
