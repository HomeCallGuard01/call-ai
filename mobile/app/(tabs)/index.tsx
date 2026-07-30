// C1 — Home / Protection Status. Per APP_VISUAL_SPECIFICATION.md: the
// hero screen — answers "Am I protected?" at a glance. Once setup is
// complete this should be almost entirely passive reassurance; the only
// interactive element is the conditional "finish setup" card.
import { useCallback, useState } from "react";
import { Text, View, StyleSheet, ActivityIndicator, RefreshControl, ScrollView } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { fetchDashboard, NotEntitledError } from "../../lib/api";
import type { DashboardResponse } from "../../lib/types";
import { colors, spacing, typography } from "../../lib/theme";

type ScreenState = "loading" | "ready" | "offline" | "not_entitled";

export default function Home() {
  const [state, setState] = useState<ScreenState>("loading");
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setIsRefreshing(true);
    try {
      const result = await fetchDashboard();
      setData(result);
      setState("ready");
    } catch (err) {
      if (err instanceof NotEntitledError) {
        setState("not_entitled");
      } else {
        // Per E3: connectivity issues must never look like a protection
        // problem — if we already have data from a previous load, keep
        // showing it with an offline banner rather than a blank error.
        setState(data ? "ready" : "offline");
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [data]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  if (state === "loading") {
    return (
      <SafeAreaView style={styles.centeredSafeArea}>
        <ActivityIndicator color={colors.accent} size="large" />
      </SafeAreaView>
    );
  }

  if (state === "not_entitled") {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.content}>
          <Text style={styles.statusTitle}>Action needed</Text>
          <Text style={styles.statusBody}>
            You don't currently have an active membership. Protect your home phone from scam
            callers today.
          </Text>
          <PrimaryButton label="Start protection" onPress={() => router.push("/(setup)/welcome")} />
        </View>
      </SafeAreaView>
    );
  }

  const isSettingUp = data && !data.protection.activationVerifiedAt;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} tintColor={colors.accent} />}
      >
        {state === "offline" && <Banner variant="notice" message="You're offline — showing your last known status." />}

        {isSettingUp ? (
          <>
            <Text style={styles.statusTitle}>Setting up</Text>
            <Text style={styles.statusBody}>Finish activating call forwarding to complete your protection.</Text>
            <PrimaryButton label="Finish setup" onPress={() => router.push("/(setup)/device-picker")} />
          </>
        ) : (
          <>
            <Text style={styles.statusTitle}>Protected</Text>
            {data && (
              <Text style={styles.statusBody}>
                {data.stats.callsScreened} unknown caller{data.stats.callsScreened === 1 ? "" : "s"} screened
                today
                {data.stats.suspectedScamsBlocked > 0
                  ? `, ${data.stats.suspectedScamsBlocked} suspected scam${data.stats.suspectedScamsBlocked === 1 ? "" : "s"} blocked.`
                  : ", all clear."}
              </Text>
            )}
          </>
        )}

        {data?.membership.status === "payment_issue" && (
          <Banner
            variant="error"
            message="There's a problem with your payment. Please update your billing details to keep your protection active."
          />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  centeredSafeArea: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    padding: spacing.lg,
    flexGrow: 1,
  },
  statusTitle: {
    ...typography.hero,
    color: colors.accent,
    marginBottom: spacing.md,
  },
  statusBody: {
    ...typography.body,
    color: colors.text,
    marginBottom: spacing.lg,
  },
});
