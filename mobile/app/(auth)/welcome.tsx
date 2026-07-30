// A2 — Welcome / Value carousel. Per APP_VISUAL_SPECIFICATION.md: 3
// panels max, "Get started" reachable from every panel (not just the
// last), footer login link always visible.
import { useState } from "react";
import { View, Text, StyleSheet, useWindowDimensions, ScrollView } from "react-native";
import { Link, router } from "expo-router";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { colors, spacing, typography } from "../../lib/theme";

const PANELS = [
  {
    headline: "Stop scam callers before they reach you",
    body: "Protect your phone from nuisance and scam callers in around 2 minutes.",
  },
  {
    headline: "Keep your number, keep your family's calls coming through exactly as normal",
    body: "Friends and family ring through immediately — nothing changes for them.",
  },
  {
    headline: "You stay in control",
    body: "See exactly what was screened and why, any time you want to check.",
  },
];

export default function Welcome() {
  const [pageIndex, setPageIndex] = useState(0);
  const { width } = useWindowDimensions();

  return (
    <Screen scroll={false}>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={e => {
          const index = Math.round(e.nativeEvent.contentOffset.x / width);
          setPageIndex(index);
        }}
        style={styles.carousel}
      >
        {PANELS.map((panel, index) => (
          <View key={index} style={[styles.panel, { width }]}>
            <Text style={styles.headline}>{panel.headline}</Text>
            <Text style={styles.body}>{panel.body}</Text>
          </View>
        ))}
      </ScrollView>

      <View style={styles.dots}>
        {PANELS.map((_, index) => (
          <View key={index} style={[styles.dot, index === pageIndex && styles.dotActive]} />
        ))}
      </View>

      <View style={styles.footer}>
        <PrimaryButton label="Get started" onPress={() => router.push("/(auth)/register")} />
        <Link href="/(auth)/login" style={styles.loginLink}>
          <Text style={styles.loginLinkText}>Already have an account? Log in</Text>
        </Link>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  carousel: {
    flex: 1,
  },
  panel: {
    padding: spacing.lg,
    justifyContent: "center",
  },
  headline: {
    ...typography.hero,
    color: colors.text,
    marginBottom: spacing.md,
  },
  body: {
    ...typography.body,
    color: colors.textMuted,
  },
  dots: {
    flexDirection: "row",
    justifyContent: "center",
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.border,
  },
  dotActive: {
    backgroundColor: colors.accent,
  },
  footer: {
    padding: spacing.lg,
  },
  loginLink: {
    alignSelf: "center",
    marginTop: spacing.md,
    padding: spacing.sm,
  },
  loginLinkText: {
    color: colors.accent,
    fontWeight: "600",
  },
});
