// A2 — Welcome / Value carousel. Per APP_VISUAL_SPECIFICATION.md: 3
// panels max, "Get started" reachable from every panel (not just the
// last), footer login link always visible.
//
// Deliberately does NOT use the shared <Screen> wrapper: Screen applies
// horizontal padding to its content container, which made every panel
// (sized to the full window width via useWindowDimensions) wider than
// the actual scrollable viewport underneath that padding. pagingEnabled
// snaps to the *ScrollView's own* width, so a panel wider than that
// snap distance meant adjacent panels bled into view, extra swipes were
// needed to bring one panel fully on-screen, and headline/body text
// overflowed the visible width — every symptom reported from the first
// physical-device test. Measuring the carousel's own onLayout width
// (not the window's) and keeping panel width in lockstep with it fixes
// all of that at the source, and self-corrects on any relayout
// (rotation, iPad Split View/Slide Over resize) rather than trusting a
// dimension that may not match what's actually on screen.
import { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, LayoutChangeEvent } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Link, router } from "expo-router";
import { PrimaryButton } from "../../components/PrimaryButton";
import { computePageIndex, shouldResyncScrollPosition, scrollOffsetForPage } from "../../lib/carousel";
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
  // 0 until the first onLayout fires — panels render with a real width
  // only once we actually know it, rather than assuming window width.
  const [carouselWidth, setCarouselWidth] = useState(0);
  const scrollRef = useRef<ScrollView>(null);

  function handleLayout(e: LayoutChangeEvent) {
    const nextWidth = e.nativeEvent.layout.width;
    setCarouselWidth(prev => (prev === nextWidth ? prev : nextWidth));
  }

  // Any width change (rotation, iPad multitasking resize, Dynamic Type
  // reflow) re-syncs the scroll offset to the current page at the new
  // width — otherwise the pixel offset from the old width would land
  // mid-panel at the new one. Skipped on the very first measurement
  // (carouselWidth was 0, nothing to re-sync from) and animated:false so
  // this correction is never itself visible as a swipe.
  const previousWidth = useRef(0);
  useEffect(() => {
    if (shouldResyncScrollPosition(previousWidth.current, carouselWidth)) {
      scrollRef.current?.scrollTo({ x: scrollOffsetForPage(pageIndex, carouselWidth), animated: false });
    }
    previousWidth.current = carouselWidth;
  }, [carouselWidth, pageIndex]);

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
      <View style={styles.carouselContainer} onLayout={handleLayout}>
        {carouselWidth > 0 && (
          <ScrollView
            ref={scrollRef}
            horizontal
            pagingEnabled
            snapToInterval={carouselWidth}
            snapToAlignment="start"
            decelerationRate="fast"
            disableIntervalMomentum
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.carouselContent}
            onMomentumScrollEnd={e => {
              const index = computePageIndex(e.nativeEvent.contentOffset.x, carouselWidth);
              setPageIndex(index);
            }}
          >
            {PANELS.map((panel, index) => (
              <View key={index} style={[styles.panel, { width: carouselWidth }]}>
                <Text style={styles.headline}>{panel.headline}</Text>
                <Text style={styles.body}>{panel.body}</Text>
              </View>
            ))}
          </ScrollView>
        )}
      </View>

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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  // Full width, no horizontal padding here — each panel supplies its own
  // (below), so the carousel's measured width is genuinely the full,
  // usable, on-screen width with no hidden inset thrown off by an
  // ancestor's padding.
  carouselContainer: {
    flex: 1,
  },
  // Without this, the horizontal ScrollView's inner content collapses to
  // its own natural content height instead of filling the container —
  // leaving each panel's justifyContent: "center" with nothing to
  // actually center within. Carried over from the previous
  // implementation, which found this the hard way (see git history);
  // still required after the width fix above.
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
    flexShrink: 1,
  },
  body: {
    ...typography.body,
    color: colors.textMuted,
    flexShrink: 1,
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
