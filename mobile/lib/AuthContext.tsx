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
import { supabase } from "./supabase";
import { bootstrapHousehold } from "./api";
import { shouldTriggerBootstrap } from "./bootstrapTrigger";

interface AuthContextValue {
  session: Session | null;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextValue>({ session: null, isLoading: true });

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
      setSession(data.session);
      setIsLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);

      const userId = newSession?.user?.id ?? null;

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
