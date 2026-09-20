// C4 — Activity list. Per APP_VISUAL_SPECIFICATION.md: the call log,
// reframed as reassurance rather than a raw technical table — plain-
// language outcome per row, not exposing ai_model/processing_time_ms
// fields. Call detail drill-down (C5) is deferred per the Launch
// Feature Matrix (Should Have, not Must Have) — this list is
// intentionally the full V1 screen, no navigation out of it.
import { useCallback, useState } from "react";
import { View, Text, FlatList, StyleSheet, ActivityIndicator, RefreshControl } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { PrimaryButton } from "../../components/PrimaryButton";
import { OutcomeRow } from "../../components/OutcomeRow";
import { EmptyState } from "../../components/EmptyState";
import { ScreenHeader } from "../../components/ScreenHeader";
import { fetchDashboard, NotEntitledError } from "../../lib/api";
import { useAuth } from "../../lib/AuthContext";
import type { DashboardActivityItem } from "../../lib/types";
import { colors, spacing } from "../../lib/theme";

// terminatedBySystem is checked BEFORE result (2026-09-13 fix) — same
// reasoning and precedence as lib/app/(tabs)/index.tsx's own
// describeActivity: result stays "SAFE" even for a call live monitoring
// genuinely stopped mid-call, so result alone previously mislabelled a
// stopped high-risk call as "no concerns". Uses the same "High risk —
// call stopped" wording as the Home screen so a customer sees a
// consistent description of the same call on either screen. Missing/
// undefined terminatedBySystem (a historic row) falls through exactly as
// before this fix.
function describeOutcome(item: DashboardActivityItem): { text: string; tone: "neutral" | "positive" | "warning" } {
  if (item.status === "Known") {
    return { text: "Rang straight through", tone: "neutral" };
  }
  if (item.terminatedBySystem === true) {
    return { text: "High risk — call stopped", tone: "warning" };
  }
  if (item.result === "SCAM") {
    return { text: "Screened — high risk, call ended", tone: "warning" };
  }
  return { text: "Screened, no concerns", tone: "positive" };
}

export default function Activity() {
  const { session } = useAuth();
  const [items, setItems] = useState<DashboardActivityItem[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [notEntitled, setNotEntitled] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setIsRefreshing(true);
    try {
      const data = await fetchDashboard(session?.access_token);
      setItems(data.activity);
      setNotEntitled(false);
    } catch (err) {
      if (err instanceof NotEntitledError) {
        setNotEntitled(true);
      } else {
        setItems(current => current ?? []);
      }
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [session?.access_token]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  if (notEntitled) {
    return (
      <View style={styles.centered}>
        <EmptyState icon="shield-outline" message="Start your protection to see which calls have been screened.">
          <View style={styles.notEntitledButton}>
            <PrimaryButton label="Start protection" onPress={() => router.push("/(setup)/welcome")} />
          </View>
        </EmptyState>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <FlatList
        style={styles.list}
        data={items}
        keyExtractor={(item, index) => `${item.time}-${index}`}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} tintColor={colors.accent} />}
        ListHeaderComponent={<ScreenHeader title="Activity" subtitle="How each call was handled" />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <EmptyState icon="time-outline" message="No calls yet — we'll let you know as soon as we screen one." />
          </View>
        }
        renderItem={({ item }) => {
          const outcome = describeOutcome(item);
          return (
            <OutcomeRow
              tone={outcome.tone}
              title={outcome.text}
              subtitle={new Date(item.time).toLocaleString("en-GB")}
            />
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background,
    padding: spacing.lg,
  },
  notEntitledButton: {
    marginTop: spacing.lg,
    alignSelf: "stretch",
  },
  list: {
    backgroundColor: colors.background,
  },
  listContent: {
    padding: spacing.lg,
    flexGrow: 1,
  },
  empty: {
    paddingTop: spacing.xxl,
  },
});
