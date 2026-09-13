// Real iPhone testing (2026-08-08) found the trusted-contact modal
// screens (choose/from-phone/add under (tabs)/contacts) had no visible
// way out — presentation: "modal" in Expo Router gives iOS's native
// swipe-down-to-dismiss gesture, but no header back/close button by
// default, and none of these screens added their own. A customer
// shouldn't need to know an iOS gesture to leave a screen. Defaults to
// router.back() — correct for a modal (dismisses it) and for a normal
// pushed screen alike; nothing here saves anything, so leaving via Back
// never persists a change that wasn't already explicitly saved.
import { Pressable, Text, StyleSheet } from "react-native";
import { router } from "expo-router";
import { colors, spacing, MIN_TOUCH_TARGET } from "../lib/theme";

export function BackLink({ label = "‹ Back", onPress }: { label?: string; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress ?? (() => router.back())} accessibilityRole="button" style={styles.backLink}>
      <Text style={styles.backLinkText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backLink: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: "center",
    marginLeft: -spacing.sm,
    marginBottom: spacing.sm,
  },
  backLinkText: {
    color: colors.accent,
    fontWeight: "600",
    fontSize: 15,
  },
});
