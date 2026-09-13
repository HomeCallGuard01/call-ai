// Shared page wrapper — safe-area handling + consistent horizontal
// padding + background colour, so no individual screen has to repeat
// this boilerplate. Scrollable by default since most V1 screens are
// short forms/lists; pass scroll={false} for screens that manage their
// own scrolling (e.g. a FlatList-based list screen).
import { ReactNode } from "react";
import { View, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, spacing } from "../lib/theme";

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={styles.content}>{children}</View>
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
