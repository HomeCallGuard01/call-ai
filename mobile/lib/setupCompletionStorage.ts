// Onboarding-verification UX change (2026-09-23): persists, per device,
// the moment this customer reached B9 (setup complete) — i.e. call
// forwarding activation was completed, whether or not it has been proven
// by a real forwarded call yet. Two things read this:
//
// 1. lib/setupFlow.ts's resumeSetupAt — a customer who has completed
//    activation but isn't verified yet must resume at "complete", never
//    be sent back to device-picker/MMI setup (that used to happen: see
//    resumeSetupAt's own comment for the exact bug).
// 2. The Home tab's "unverified setup" reminder — "Let's check your
//    protection" only appears once a meaningful amount of time has
//    passed since setup was completed, not the instant it is.
//
// Deliberately client-only, not a new households column/migration: the
// backend already has no field for "the customer tapped through the
// activation screen" (only activation_verified_at/delivery_verified_at,
// which are evidence, not intent), and the approved brief for this
// change explicitly prefers reusing existing state over adding new
// infrastructure. Same storage mechanism already used for exactly this
// kind of "remember something from setup, locally" need — see
// activationDeviceStorage.ts. Not sensitive data (just a timestamp).
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

const STORAGE_KEY = "hcg_setup_completed_at";

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

async function removeItem(key: string): Promise<void> {
  if (Platform.OS === "web") {
    globalThis.localStorage?.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

// Write-once, like activation_verified_at on the backend: re-reaching
// B9 (e.g. "Change device" -> redo activation -> complete again) must
// not push the reminder clock back out for a household that has
// genuinely been unverified since its first completion.
export async function markSetupCompleted(): Promise<void> {
  try {
    const existing = await getItem(STORAGE_KEY);
    if (existing) return;
    await setItem(STORAGE_KEY, new Date().toISOString());
  } catch {
    // Best-effort only. Worst case: resumeSetupAt falls back to backend
    // evidence alone (its pre-existing, already-safe behaviour) and the
    // Home reminder simply never fires for this device — never a crash,
    // never a false "you're all set" claim either way.
  }
}

export async function loadSetupCompletedAt(): Promise<string | null> {
  try {
    return await getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

// Called alongside resetVoiceRegistrationState() at every sign-out site —
// this timestamp is per-household, not per-device, so it must never
// survive into a different household signing into the same device.
export async function clearSetupCompletedAt(): Promise<void> {
  try {
    await removeItem(STORAGE_KEY);
  } catch {
    // Best-effort — see saveActivationDevice's identical convention.
  }
}
