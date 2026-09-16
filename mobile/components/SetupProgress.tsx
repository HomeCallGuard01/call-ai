// Persistent step indicator shown across the guided setup flow
// (subscribe -> contacts -> device-picker/activate/verify), so a
// customer always knows roughly how much is left rather than each
// screen feeling like an unbounded sequence. Deliberately three steps,
// not five or six — see lib/setupFlow.ts for why device-picker/activate/
// verify collapse into one visible "Activate" step.
import { View, Text, StyleSheet } from "react-native";
import { SETUP_STEPS } from "../lib/setupFlow";
import { colors, spacing } from "../lib/theme";

export function SetupProgress({ currentStep }: { currentStep: 1 | 2 | 3 }) {
  return (
    <View
      style={styles.container}
      accessibilityRole="progressbar"
      accessibilityLabel={`Setup step ${currentStep} of ${SETUP_STEPS.length}: ${SETUP_STEPS[currentStep - 1]}`}
      accessibilityValue={{ min: 1, max: SETUP_STEPS.length, now: currentStep }}
      importantForAccessibility="no-hide-descendants"
    >
      {SETUP_STEPS.map((label, index) => {
        const step = index + 1;
        const isDone = step < currentStep;
        const isCurrent = step === currentStep;
        return (
          <View key={label} style={styles.item}>
            <View style={styles.trackRow}>
              <View style={[styles.dot, (isDone || isCurrent) && styles.dotFilled]}>
                {isDone && <Text style={styles.dotCheck}>✓</Text>}
              </View>
              {index < SETUP_STEPS.length - 1 && (
                <View style={[styles.line, isDone && styles.lineFilled]} />
              )}
            </View>
            <Text style={[styles.label, isCurrent && styles.labelCurrent]} numberOfLines={1}>
              {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const DOT_SIZE = 22;

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    marginBottom: spacing.lg,
  },
  item: {
    flex: 1,
    alignItems: "flex-start",
  },
  trackRow: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  dotFilled: {
    borderColor: colors.accent,
    backgroundColor: colors.accentMuted,
  },
  dotCheck: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "700",
  },
  line: {
    flex: 1,
    height: 2,
    backgroundColor: colors.border,
    marginHorizontal: 4,
  },
  lineFilled: {
    backgroundColor: colors.accent,
  },
  label: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  labelCurrent: {
    color: colors.text,
    fontWeight: "700",
  },
});
