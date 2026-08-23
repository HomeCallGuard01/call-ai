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
  // evidence, two rounds): firing this unconditionally on mount raced
  // Supabase's own session hydration — gating on `session` (round 1)
  // wasn't sufficient by itself, because a fresh authorizedFetch()-internal
  // supabase.auth.getSession() call was still sometimes returning null even
  // after this `session` was already non-null (a client-internal timing
  // issue with this supabase-js version, not just a mount-order race).
  // Round 2: pass this exact, already-known-good session's access_token
  // straight through instead of letting registerForIncomingCalls() re-derive
  // it via a second getSession() call — see lib/api.ts's fetchVoiceToken.
  // Retains the bounded retry from round 1 for genuine transient failures.
  useEffect(() => {
    if (!session) return;

    let cancelled = false;

    function attempt(isRetry: boolean): void {
      registerForIncomingCalls(session!.access_token).catch((err) => {
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
