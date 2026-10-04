// Setup progress on Home (1.0.2, 2026-10-04). Renders lib/protectionView.ts's
// buildSetupChecklist — every tick is a server gate (protectionBlockers),
// never "the app asked the customer to do this". A step the server could not
// establish renders as "Checking…", with no tick and no cross.
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ChecklistStep } from "../lib/protectionView";
import { colors, radius, spacing, typography } from "../lib/theme";

export function ProtectionChecklist({ steps }: { steps: ChecklistStep[] }) {
  const doneCount = steps.filter(s => s.state === "done").length;
  return (
    <View style={styles.card} accessibilityLabel={`Setup progress: ${doneCount} of ${steps.length} steps complete`}>
      <Text style={styles.eyebrow}>YOUR SETUP</Text>
      {steps.map((step, index) => {
        const done = step.state === "done";
        const unknown = step.state === "unknown";
        return (
          <View
            key={step.key}
            style={[styles.row, index < steps.length - 1 && styles.rowBorder]}
            accessible
            accessibilityLabel={`${step.label}: ${done ? "done" : unknown ? "checking" : "not done yet"}`}
          >
            <View style={[styles.badge, done ? styles.badgeDone : styles.badgeTodo]}>
              {done ? (
                <Ionicons name="checkmark" size={16} color={colors.onAccent} />
              ) : (
                <Text style={styles.badgeNumber}>{unknown ? "?" : index + 1}</Text>
              )}
            </View>
            <Text style={[styles.label, done ? styles.labelDone : styles.labelTodo]}>{step.label}</Text>
            {unknown && <Text style={styles.status}>Checking…</Text>}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    marginBottom: spacing.lg,
  },
  eyebrow: {
    ...typography.eyebrow,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  rowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  badge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeDone: {
    backgroundColor: colors.accent,
  },
  badgeTodo: {
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
  },
  badgeNumber: {
    ...typography.caption,
    color: colors.textMuted,
    fontWeight: "700",
  },
  label: {
    ...typography.body,
    flex: 1,
  },
  labelDone: {
    color: colors.text,
  },
  labelTodo: {
    color: colors.textMuted,
  },
  status: {
    ...typography.caption,
    color: colors.textMuted,
  },
});
