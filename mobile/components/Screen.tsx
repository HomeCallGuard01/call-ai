// Shared page wrapper — safe-area handling + consistent horizontal
// padding + background colour, so no individual screen has to repeat
// this boilerplate. Scrollable by default since most V1 screens are
// short forms/lists; pass scroll={false} for screens that manage their
// own scrolling (e.g. a FlatList-based list screen).
//
// `brand` (UI upgrade, 2026-09-20) adds the Home Call Guard logo lockup
// above the content — for the signed-out and guided-setup screens, which
// have no native header, so the brand reads consistently from the first
// screen. Presentation only; children render exactly as before.
import { ReactNode } from "react";
import { View, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BrandMark } from "./BrandMark";
import { colors, spacing } from "../lib/theme";

export function Screen({ children, scroll = true, brand = false }: { children: ReactNode; scroll?: boolean; brand?: boolean }) {
  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          {brand && <BrandMark size="md" />}
          {children}
        </ScrollView>
      ) : (
        <View style={styles.content}>
          {brand && <BrandMark size="md" />}
          {children}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    padding: spacing.lg,
    flexGrow: 1,
  },
  content: {
    flex: 1,
    padding: spacing.lg,
  },
});
