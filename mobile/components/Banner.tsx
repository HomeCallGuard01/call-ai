import { View, Text, StyleSheet } from "react-native";
import { colors, spacing } from "../lib/theme";

type Variant = "error" | "notice";

// Matches the web app's existing .error-banner / .notice-banner styling
// (public/login.html, public/register.html) — same visual language,
// same distinction between a problem (error) and a neutral status
// update (notice, e.g. E3's offline banner).
export function Banner({ variant, message }: { variant: Variant; message: string }) {
  return (
    <View style={[styles.banner, variant === "error" ? styles.error : styles.notice]}>
      <Text style={[styles.text, variant === "error" ? styles.errorText : styles.noticeText]}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderRadius: 10,
    borderWidth: 2,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  error: {
    backgroundColor: colors.dangerBackground,
    borderColor: colors.danger,
  },
  notice: {
    backgroundColor: colors.accentMuted,
    borderColor: colors.accent,
  },
  text: {
    fontSize: 15,
    lineHeight: 21,
  },
  errorText: {
    color: "#fde68a",
  },
  noticeText: {
    color: "#bbf7d0",
  },
});
