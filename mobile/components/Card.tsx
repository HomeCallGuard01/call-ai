// Shared surface — the rounded, softly-bordered panel used for every
// grouped block of content, so hierarchy (a card is "a thing") is the same
// on every screen. `tone` tints the border and background to match the
// app's real outcome colours (see lib/theme.ts); it is presentation only.
import { ReactNode } from "react";
import { View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { colors, radius, spacing } from "../lib/theme";

export type Tone = "default" | "neutral" | "positive" | "warning";

export function Card({ children, tone = "default", style }: { children: ReactNode; tone?: Tone; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, TONE[tone], style]}>{children}</View>;
}

const TONE = StyleSheet.create({
  default: {},
  neutral: { borderColor: colors.borderStrong },
  positive: { borderColor: colors.accent, backgroundColor: colors.accentMuted },
  warning: { borderColor: colors.danger, backgroundColor: colors.dangerBackground },
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
});
