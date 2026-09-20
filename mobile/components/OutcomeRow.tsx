// One call outcome, as a card row: coloured icon badge + plain-English
// outcome + time. Used by both the Activity tab and Home's recent
// activity preview so a call looks the same wherever it appears.
//
// Only the app's real outcomes exist here (see lib/theme.ts):
//   neutral  -> a trusted contact rang straight through
//   positive -> screened, no concerns
//   warning  -> high risk, call stopped or ended
// The caller decides which applies (activity.tsx's describeOutcome /
// index.tsx's describeActivity — unchanged); this component only draws it.
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing, typography } from "../lib/theme";

export type OutcomeTone = "neutral" | "positive" | "warning";

const META: Record<OutcomeTone, { icon: keyof typeof Ionicons.glyphMap; color: string; soft: string }> = {
  neutral: { icon: "person", color: colors.neutral, soft: colors.neutralSoft },
  positive: { icon: "shield-checkmark", color: colors.accent, soft: colors.accentSoft },
  warning: { icon: "warning", color: colors.danger, soft: colors.dangerSoft },
};

export function OutcomeRow({ tone, title, subtitle, compact = false }: { tone: OutcomeTone; title: string; subtitle: string; compact?: boolean }) {
  const m = META[tone];
  return (
    <View style={[styles.row, compact && styles.rowCompact]}>
      <View style={[styles.badge, compact && styles.badgeCompact, { backgroundColor: m.soft }]}>
        <Ionicons name={m.icon} size={20} color={m.color} accessibilityElementsHidden importantForAccessibility="no" />
      </View>
      <View style={styles.text}>
        <Text style={[styles.title, tone === "warning" && { color: colors.dangerText }]}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowCompact: {
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
  },
  badgeCompact: {
    width: 34,
    height: 34,
    borderRadius: 17,
  },
  badge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  text: {
    flex: 1,
  },
  title: {
    ...typography.body,
    color: colors.text,
    fontWeight: "600",
  },
  subtitle: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: 2,
  },
});
