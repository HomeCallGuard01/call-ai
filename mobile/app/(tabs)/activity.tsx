// C4 — Activity list. Per APP_VISUAL_SPECIFICATION.md: the call log,
// reframed as reassurance rather than a raw technical table — plain-
// language outcome per row, not exposing ai_model/processing_time_ms
// fields. Call detail drill-down (C5) is deferred per the Launch
// Feature Matrix (Should Have, not Must Have) — this list is
// intentionally the full V1 screen, no navigation out of it.
import { useCallback, useState } from "react";
import { View, Text, FlatList, StyleSheet, ActivityIndicator, RefreshControl } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { PrimaryButton } from "../../components/PrimaryButton";
import { fetchDashboard, NotEntitledError } from "../../lib/api";
import { useAuth } from "../../lib/AuthContext";
import type { DashboardActivityItem } from "../../lib/types";
import { colors, spacing, typography } from "../../lib/theme";

function describeOutcome(item: DashboardActivityItem): { text: string; tone: "neutral" | "positive" | "warning" } {
  if (item.status === "Known") {
    return { text: "Rang straight through", tone: "neutral" };
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
        <Text style={styles.emptyText}>
          Start your protection to see which calls have been screened.
        </Text>
        <View style={styles.notEntitledButton}>
          <PrimaryButton label="Start protection" onPress={() => router.push("/(setup)/welcome")} />
        </View>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.list}
      data={items}
      keyExtractor={(item, index) => `${item.time}-${index}`}
      contentContainerStyle={styles.listContent}
      refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} tintColor={colors.accent} />}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No calls yet — we'll let you know as soon as we screen one.</Text>
        </View>
      }
      renderItem={({ item }) => {
        const outcome = describeOutcome(item);
        return (
          <View style={styles.row}>
            <View style={[styles.dot, styles[`dot_${outcome.tone}`]]} />
            <View style={styles.rowText}>
              <Text style={styles.outcome}>{outcome.text}</Text>
              <Text style={styles.time}>{new Date(item.time).toLocaleString("en-GB")}</Text>
            </View>
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
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
    alignItems: "center",
  },
  emptyText: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: spacing.md,
  },
  dot_neutral: {
    backgroundColor: colors.textMuted,
  },
  dot_positive: {
    backgroundColor: colors.accent,
  },
  dot_warning: {
    backgroundColor: colors.danger,
  },
  rowText: {
    flex: 1,
  },
  outcome: {
    ...typography.body,
    color: colors.text,
  },
  time: {
    ...typography.caption,
    color: colors.textMuted,
  },
});
