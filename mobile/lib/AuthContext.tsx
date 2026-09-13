// One shared source of truth for the current Supabase session, consumed
// by every screen via useAuth(). Centralising this here means E4
// (session expired) is handled in exactly one place — onAuthStateChange
// firing with a null session redirects to login from wherever the
// customer happens to be, per APP_VISUAL_SPECIFICATION.md's E4 spec
// ("re-authenticating should return the customer to exactly where they
// were, not force them back through onboarding") — Expo Router's stack
// preserves the navigation history underneath the login screen, so
// going back after re-auth lands where the customer left off.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { router } from "expo-router";
import { supabase } from "./supabase";
import { bootstrapHousehold } from "./api";
import { shouldTriggerBootstrap } from "./bootstrapTrigger";
import { configurePurchases, resetPurchasesIdentity } from "./purchases";

interface AuthContextValue {
  session: Session | null;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextValue>({ session: null, isLoading: true });

// TEMPORARY diagnostic (2026-08-23 physical device verification) — decodes
// just the JWT header (never the payload/signature) to report which
// signing key a given session's access_token actually carries, since a
// real device's persisted-session/stale-key behaviour can't otherwise be
// observed remotely. Remove once resolved.
function decodedKid(accessToken: string | undefined): string {
  if (!accessToken) return "none";
  try {
    const headerB64 = accessToken.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const padded = headerB64 + "=".repeat((4 - (headerB64.length % 4)) % 4);
    const header = JSON.parse(globalThis.atob(padded));
    return header.kid || "no-kid";
  } catch {
    return "decode-failed";
  }
}

// iat/exp (numeric timestamps only, never sub/email/role) prove whether a
// token was actually just minted or is a stale one being replayed — the
// missing piece to distinguish "server issuing an old key" from "device
// replaying an old token" regardless of what event name fired.
function decodedAge(accessToken: string | undefined): string {
  if (!accessToken) return "none";
  try {
    const payloadB64 = accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const payload = JSON.parse(globalThis.atob(padded));
    const nowSec = Math.floor(Date.now() / 1000);
    return `iat=${payload.iat} (${nowSec - payload.iat}s ago) exp=${payload.exp}`;
  } catch {
    return "decode-failed";
  }
}

function authBeacon(stage: string, detail?: string): void {
  try {
    const base = process.env.EXPO_PUBLIC_API_BASE_URL;
    if (!base) return;
    fetch(`${base}/debug/voice-beacon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: `auth:${stage}`, detail }),
    }).catch(() => {});
  } catch {
    // never let diagnostics break real auth handling
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // The user id bootstrap last ran (or is currently running) for, in this
  // client lifetime — see lib/bootstrapTrigger.ts. Cleared back to null
  // on failure so a later trigger event can retry; a ref (not state)
  // since it must be read/written synchronously inside the auth-state
  // callback without waiting for a re-render.
  const bootstrappedUserId = useRef<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      authBeacon(
        "initial-getSession",
        `${decodedKid(data.session?.access_token)} | ${decodedAge(data.session?.access_token)}`
      );
      setSession(data.session);
      setIsLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((event, newSession) => {
      authBeacon(
        `onAuthStateChange:${event}`,
        `${decodedKid(newSession?.access_token)} | ${decodedAge(newSession?.access_token)}`
      );
      setSession(newSession);

      // The comment this function opens with has always described this
      // redirect as existing ("firing with a null session redirects to
      // login from wherever the customer happens to be") but the actual
      // call was never written — confirmed live during RC1 staging E2E
      // testing, 2026-08-04: logging out from the Account tab correctly
      // cleared the session but left the screen showing an infinite
      // loading spinner forever, since that screen's own dashboard-fetch
      // failure has nothing that would navigate it anywhere. SIGNED_OUT
      // covers both a manual sign-out and Supabase invalidating a session
      // it can no longer refresh (E4), matching the doc comment's intent
      // for both cases.
      if (event === "SIGNED_OUT") {
        router.replace("/(auth)/welcome");
        resetPurchasesIdentity();
      }

      const userId = newSession?.user?.id ?? null;

      // iOS-only no-op on Android/web (see lib/purchases.ts). Configured
      // here, not just in the tabs layout, so it's ready before the
      // Subscribe screen — reachable from (setup), before (tabs) — ever
      // needs it. Uses this exact auth_user_id as the RevenueCat App
      // User ID so a purchase always maps back to the right household —
      // see the webhook route's own comment for the matching lookup.
      if (userId) {
        configurePurchases(userId);
      }

      if (shouldTriggerBootstrap({ event, userId, alreadyBootstrappedUserId: bootstrappedUserId.current })) {
        // Marked optimistically, before the call resolves — this is what
        // makes the dedup actually race-safe rather than just "usually
        // fine": a second trigger event for the same user arriving while
        // the first call is still in flight sees this immediately, not
        // only after the first call's .then()/.catch() runs.
        bootstrappedUserId.current = userId;

        // Deliberately fire-and-forget with just a console log on
        // failure, not a thrown error — a transient bootstrap failure
        // here shouldn't block the customer from reaching the app; the
        // next screen that actually needs a household (the dashboard
        // call) will surface a real, visible error if it's still
        // missing, rather than this silent background call blocking
        // sign-in itself.
        bootstrapHousehold(newSession!.access_token, newSession!.refresh_token).catch(err => {
          console.error("HOUSEHOLD BOOTSTRAP FAILED:", err);
          // Allow a future trigger event (e.g. the next app launch's
          // INITIAL_SESSION, or a subsequent sign-in) to retry rather
          // than permanently treating this user as "already handled"
          // after a failure that was never actually fixed.
          if (bootstrappedUserId.current === userId) {
            bootstrappedUserId.current = null;
          }
        });
      }
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  return <AuthContext.Provider value={{ session, isLoading }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
