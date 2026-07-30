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
        contentContainerStyle={styles.carouselContent}
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
  // Without this, ScrollView's inner content collapses to its own
  // natural content height instead of filling the ScrollView's flex:1
  // container — leaving each panel's justifyContent: "center" with
  // nothing to actually center within (content stuck at the top, with a
  // large dead gap below it instead). Found via real visual testing,
  // not something a type-check can catch.
  // flexGrow on this row-direction container only grows its main axis
  // (width) — it does NOT stretch height. alignItems: "stretch" (the
  // default, restated for clarity) makes each row *child* (each panel)
  // stretch to the container's cross-axis size, but the container itself
  // still needs an explicit height for that to mean anything — height:
  // "100%" resolves against the ScrollView's own measured height, which
  // is the actual, correct fix (confirmed by re-inspecting the rendered
  // DOM after the flexGrow-only attempt changed nothing visible).
  carouselContent: {
    flexGrow: 1,
    height: "100%",
  },
  panel: {
    height: "100%",
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
