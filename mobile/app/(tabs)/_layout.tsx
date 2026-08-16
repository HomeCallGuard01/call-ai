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

export default function TabsLayout() {
  // Same-phone delivery milestone (docs/operations/HANDOVER_2026-08-15.md
  // §12-13): registers this device to receive an approved call directly,
  // bypassing PSTN. Fired once per (tabs) mount — i.e. once the customer
  // is logged in and entitled, matching GET /api/v1/voice/token's own
  // requireEntitlement gate server-side. TODO (harden later): retry on
  // failure, re-register before token expiry, surface registration state
  // in the UI instead of console-only.
  useEffect(() => {
    registerForIncomingCalls().catch((err) => {
      console.error("VOICE REGISTRATION FAILED:", err);
    });
  }, []);

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
