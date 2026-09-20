import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing } from "../lib/theme";

type Variant = "error" | "notice";

// Matches the web app's existing .error-banner / .notice-banner styling
// (public/login.html, public/register.html) — same visual language,
// same distinction between a problem (error) and a neutral status
// update (notice, e.g. E3's offline banner). UI upgrade (2026-09-20):
// colours now come from lib/theme.ts (this file previously held two
// colour literals) and each variant carries a small icon.
export function Banner({ variant, message }: { variant: Variant; message: string }) {
  const isError = variant === "error";
  return (
    <View style={[styles.banner, isError ? styles.error : styles.notice]}>
      <Ionicons
        name={isError ? "alert-circle" : "information-circle"}
        size={20}
        color={isError ? colors.danger : colors.accent}
        style={styles.icon}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
      <Text style={[styles.text, isError ? styles.errorText : styles.noticeText]}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    borderRadius: radius.md,
    borderWidth: 1.5,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  icon: {
    marginRight: spacing.sm,
    marginTop: 1,
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
    flex: 1,
    fontSize: 15,
    lineHeight: 21,
  },
  errorText: {
    color: colors.dangerText,
  },
  noticeText: {
    color: colors.noticeText,
  },
});
