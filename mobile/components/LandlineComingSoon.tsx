// Shared "Landline is coming soon" content, rendered inside each screen's own
// <Screen> wrapper (device picker, Subscribe, Activate, Set up call
// forwarding). Copy lives in lib/landlineAvailability.ts so every place that
// says it says exactly the same thing. No form, no waiting-list capture —
// nothing here can start setup or payment.
import { Text, StyleSheet } from "react-native";
import { PrimaryButton } from "./PrimaryButton";
import { colors, spacing, typography } from "../lib/theme";
import { LANDLINE_COMING_SOON_TITLE, LANDLINE_COMING_SOON_BODY } from "../lib/landlineAvailability";

interface Props {
  actionLabel?: string;
  onAction?: () => void;
}

export function LandlineComingSoon({ actionLabel, onAction }: Props) {
  return (
    <>
      <Text style={styles.title} accessibilityRole="header">{LANDLINE_COMING_SOON_TITLE}</Text>
      <Text style={styles.body}>{LANDLINE_COMING_SOON_BODY}</Text>
      {actionLabel && onAction ? <PrimaryButton label={actionLabel} onPress={onAction} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  title: {
    ...typography.hero,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  body: {
    ...typography.body,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
});
