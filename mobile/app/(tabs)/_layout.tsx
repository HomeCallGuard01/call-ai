// C1-C6's tab bar: Home / Contacts / Activity / Account, per
// APP_VISUAL_SPECIFICATION.md's core daily-use structure. Text labels
// always shown alongside icons (never icon-only) — per the persona
// review's explicit finding.
//
// Uses expo-router's `Tabs` (re-exported from "expo-router" directly).
// SDK 57 marks this deprecated in favour of `expo-router/js-tabs`, but
// that's a newer, less-established API this session has no way to
// visually verify — using the stable, well-documented one deliberately.
// Worth revisiting once the newer API has more real-world usage.
import { useEffect } from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { registerForIncomingCalls } from "../../lib/voiceClient";
import { useAuth } from "../../lib/AuthContext";

export default function TabsLayout() {
  const { session } = useAuth();

  // Same-phone delivery milestone (docs/operations/HANDOVER_2026-08-15.md
  // §12-13): registers this device to receive an approved call directly,
  // bypassing PSTN. Fixed 2026-08-23 (real-device diagnostic beacon
  // evidence): firing this unconditionally on mount raced Supabase's own
  // session hydration on a fresh login/cold launch — authorizedFetch's
  // getSession() call inside fetchVoiceToken() would sometimes still see
  // no session even though (tabs) had already mounted, so registration
  // failed with "unauthenticated" and (per the old TODO here) never
  // retried. Now gated on the same `session` this app already treats as
  // the single source of truth (lib/AuthContext.tsx), re-firing whenever
  // it transitions from absent to present, with one bounded retry if it
  // still fails — a real transient (network blip, cold-start timing)
  // shouldn't permanently leave a household unable to receive calls.
  useEffect(() => {
    if (!session) return;

    let cancelled = false;

    function attempt(isRetry: boolean): void {
      registerForIncomingCalls().catch((err) => {
        console.error("VOICE REGISTRATION FAILED:", err);
        if (!isRetry && !cancelled) {
          setTimeout(() => {
            if (!cancelled) attempt(true);
          }, 3000);
        }
      });
    }

    attempt(false);

    return () => {
      cancelled = true;
    };
  }, [session]);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "home" : "home-outline"} color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: "Contacts",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "people" : "people-outline"} color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: "Activity",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "time" : "time-outline"} color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: "Account",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "person" : "person-outline"} color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
