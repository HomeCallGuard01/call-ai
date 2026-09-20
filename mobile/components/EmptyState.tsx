// Shared empty / notice state: icon badge + message. Copy is always passed
// in by the screen (unchanged from before the redesign) — this only gives
// every "nothing here yet" moment the same calm, branded treatment instead
// of bare grey text.
import { ReactNode } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, typography } from "../lib/theme";

export function EmptyState({ icon, message, children }: { icon: keyof typeof Ionicons.glyphMap; message: string; children?: ReactNode }) {
  return (
    <View style={styles.wrap}>
      <View style={styles.badge}>
        <Ionicons name={icon} size={30} color={colors.accent} accessibilityElementsHidden importantForAccessibility="no" />
      </View>
      <Text style={styles.message}>{message}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    paddingHorizontal: spacing.md,
  },
  badge: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: colors.accentSoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  message: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: "center",
    lineHeight: 23,
  },
});
