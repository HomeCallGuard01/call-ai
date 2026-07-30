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
import { Tabs } from "expo-router";
import { colors } from "../../lib/theme";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Home" }} />
      <Tabs.Screen name="contacts" options={{ title: "Contacts" }} />
      <Tabs.Screen name="activity" options={{ title: "Activity" }} />
      <Tabs.Screen name="account" options={{ title: "Account" }} />
    </Tabs>
  );
}
