// The mobile app talks to Supabase Auth directly (signUp/signInWithPassword/
// resend/resetPasswordForEmail/updateUser), exactly as the web app does via
// its own `supabase` client in server.js — per docs/mobile-app/
// APP_DECISION_005 ("the app authenticates directly against Supabase Auth
// using the Supabase JS client... stores the session via Expo SecureStore").
// The session (access + refresh token) is then sent as a Bearer header to
// the backend's new /api/v1 routes (see api.ts), verified there by
// middleware/requireAuthApi.js — the same Supabase project, two different
// client-auth models for two different client types.
import { Platform } from "react-native";
import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";

// expo-secure-store's API is async and (on iOS) backed by the Keychain,
// which is why a small adapter is needed — Supabase's client expects a
// storage interface shaped like localStorage/AsyncStorage
// (getItem/setItem/removeItem, each returning/accepting a Promise here).
//
// expo-secure-store has genuinely no web implementation at all (confirmed:
// the package ships no SecureStore.web.js) — web was never a target
// platform for this product, but react-native-web is now a real
// dependency (added for local visual QA via a browser), so a web branch
// is needed for the app to run there at all rather than crashing on
// first launch. localStorage is the standard, Supabase-documented
// fallback for exactly this combination — not a security-relevant choice
// for this app in practice, since iOS/Android (the only real distribution
// targets) always use the real Keychain/EncryptedSharedPreferences-backed
// SecureStore, never this branch.
const SecureStoreAdapter: SupportedStorage = Platform.OS === "web"
  ? {
      getItem: async (key: string) => globalThis.localStorage?.getItem(key) ?? null,
      setItem: async (key: string, value: string) => globalThis.localStorage?.setItem(key, value),
      removeItem: async (key: string) => globalThis.localStorage?.removeItem(key),
    }
  : {
      getItem: (key: string) => SecureStore.getItemAsync(key),
      setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
      removeItem: (key: string) => SecureStore.deleteItemAsync(key),
    };

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY must be set (see .env.example) — " +
      "these are the same anon-key values server.js already uses, safe to expose to a client " +
      "(protected by RLS, not secrecy — same as the web app's own anon key)."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: SecureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    // The app reads recovery/confirmation tokens from a deep-link URL
    // itself (expo-router + expo-linking handle the platform-level deep
    // link; see app/reset-password.tsx) rather than relying on Supabase's
    // own browser-oriented URL-detection, which assumes a web location bar.
    detectSessionInUrl: false,
  },
});
