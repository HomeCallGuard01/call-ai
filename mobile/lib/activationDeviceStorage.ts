// Persists which device/provider the customer activated with, purely so
// the "Need to turn protection off?" section (Account tab) can show the
// real cancel code after setup is complete — the backend has no
// household column for this (deviceType/provider are query params only,
// see routes/mobileApi.js), so without this the cancel code would only
// ever be visible during the one-time activation screen itself. Not
// sensitive data (just "which kind of phone"), stored the same way this
// app already persists its Supabase session (see lib/supabase.ts).
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import type { DeviceType, LandlineProvider } from "./types";

const STORAGE_KEY = "hcg_activation_device";

export interface StoredActivationDevice {
  deviceType: DeviceType;
  provider?: LandlineProvider;
}

// Same web-vs-native split as lib/supabase.ts's SecureStoreAdapter —
// expo-secure-store has no web implementation, and react-native-web is
// a real (if secondary) target for local visual QA.
async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === "web") return globalThis.localStorage?.getItem(key) ?? null;
  return SecureStore.getItemAsync(key);
}

async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    globalThis.localStorage?.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

export async function saveActivationDevice(device: StoredActivationDevice): Promise<void> {
  try {
    await setItem(STORAGE_KEY, JSON.stringify(device));
  } catch {
    // Best-effort only — the primary display of the cancel code is the
    // activation screen itself, this just extends how long it stays
    // reachable. A storage failure here should never block activation.
  }
}

export async function loadActivationDevice(): Promise<StoredActivationDevice | null> {
  try {
    const raw = await getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.deviceType === "string") return parsed as StoredActivationDevice;
    return null;
  } catch {
    return null;
  }
}
