// One shared source of truth for the current Supabase session, consumed
// by every screen via useAuth(). Centralising this here means E4
// (session expired) is handled in exactly one place — onAuthStateChange
// firing with a null session redirects to login from wherever the
// customer happens to be, per APP_VISUAL_SPECIFICATION.md's E4 spec
// ("re-authenticating should return the customer to exactly where they
// were, not force them back through onboarding") — Expo Router's stack
// preserves the navigation history underneath the login screen, so
// going back after re-auth lands where the customer left off.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { bootstrapHousehold } from "./api";

interface AuthContextValue {
  session: Session | null;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextValue>({ session: null, isLoading: true });

// Events that mean "a session genuinely just started" — SIGNED_IN covers
// register-with-immediate-session (rare, only if email confirmation is
// ever turned off) and login; PASSWORD_RECOVERY covers the recovery
// deep-link (A7). Deliberately excludes TOKEN_REFRESHED and
// INITIAL_SESSION — bootstrap is idempotent so calling it on those
// wouldn't be wrong, just redundant on every app foreground.
const BOOTSTRAP_TRIGGER_EVENTS = new Set(["SIGNED_IN", "PASSWORD_RECOVERY"]);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setIsLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);

      if (BOOTSTRAP_TRIGGER_EVENTS.has(event) && newSession) {
        // Deliberately fire-and-forget with just a console log on
        // failure, not a thrown error — a transient bootstrap failure
        // here shouldn't block the customer from reaching the app; the
        // next screen that actually needs a household (the dashboard
        // call) will surface a real, visible error if it's still
        // missing, rather than this silent background call blocking
        // sign-in itself.
        bootstrapHousehold(newSession.access_token, newSession.refresh_token).catch(err => {
          console.error("HOUSEHOLD BOOTSTRAP FAILED:", err);
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
