// C1 — Home / Protection Status. Per APP_VISUAL_SPECIFICATION.md: the
// hero screen — answers "Am I protected?" at a glance. Once setup is
// complete this should be almost entirely passive reassurance; the only
// interactive element is the conditional "finish setup" card.
import { useCallback, useEffect, useState } from "react";
import { Text, View, StyleSheet, ActivityIndicator, RefreshControl, ScrollView } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { fetchDashboard, NotEntitledError } from "../../lib/api";
import { useAuth } from "../../lib/AuthContext";
import { deriveLoadOutcome, isSettingUp as computeIsSettingUp } from "../../lib/homeStatus";
import type { DashboardResponse } from "../../lib/types";
import { colors, spacing, typography } from "../../lib/theme";

// "ready" is the only state in which `data` is guaranteed non-null and
// backend-confirmed for the *current* user — every other state must never
// render "Protected" or "Setting up", both of which claim knowledge about
// protection status we don't actually have. Fail closed, not open.
type ScreenState = "loading" | "ready" | "unavailable" | "not_entitled";

export default function Home() {
  const { session } = useAuth();
  const [state, setState] = useState<ScreenState>("loading");
  const [data, setData] = useState<DashboardResponse | null>(null);
  // True when `data` is from a previous successful load and the most
  // recent refresh attempt failed — distinct from "unavailable" (no
  // confirmed data has ever existed for this session). Only this case
  // is allowed to keep showing last-known status (per E3: a connectivity
  // blip must never look like a protection problem) — it can only ever
  // become true from a state that already had real data.
  const [isStale, setIsStale] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Identity changed (sign-out/sign-in as a different account, or session
  // lost) — any previously-loaded data belonged to a different user and
  // must never be shown as this user's status, even for an instant while
  // the next load() is in flight. See Priority 5/2: no cached household
  // state from a previous or failed session may be attributed to the
  // current user.
  useEffect(() => {
    setData(null);
    setIsStale(false);
    setState("loading");
  }, [session?.user?.id]);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setIsRefreshing(true);
    let succeeded = false;
    let isNotEntitledError = false;
    let result: DashboardResponse | null = null;

    try {
      result = await fetchDashboard();
      succeeded = true;
    } catch (err) {
      isNotEntitledError = err instanceof NotEntitledError;
    } finally {
      setIsRefreshing(false);
    }

    // See lib/homeStatus.ts — this is the single, tested decision point
    // for what the screen is allowed to claim next. hadPriorData reads
    // the current `data` closure value, which is exactly what "prior to
    // this attempt" means here.
    const outcome = deriveLoadOutcome({ succeeded, isNotEntitledError, hadPriorData: !!data });

    if (outcome.kind === "has_data") {
      if (succeeded) setData(result);
      setIsStale(outcome.isStale);
      setState("ready");
    } else if (outcome.kind === "not_entitled") {
      setData(null);
      setState("not_entitled");
    } else {
      setIsStale(false);
      setState("unavailable");
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

  if (state === "unavailable") {
    return (
      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} tintColor={colors.accent} />}
        >
          <Text style={styles.statusTitle}>Protection status unavailable</Text>
          <Text style={styles.statusBody}>
            We couldn't confirm your protection status. Check your connection and try again.
          </Text>
          <PrimaryButton label="Try again" onPress={() => load()} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  // state === "ready" from here on — `data` is guaranteed non-null and
  // was positively confirmed by the backend for the current user (or is
  // the last such confirmation, with isStale flagging that explicitly).
  const isSettingUp = computeIsSettingUp(data!);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} tintColor={colors.accent} />}
      >
        {isStale && <Banner variant="notice" message="You're offline — showing your last known status." />}

        {isSettingUp ? (
          <>
            <Text style={styles.statusTitle}>Setting up</Text>
            <Text style={styles.statusBody}>Finish activating call forwarding to complete your protection.</Text>
            <PrimaryButton label="Finish setup" onPress={() => router.push("/(setup)/device-picker")} />
          </>
        ) : (
          <>
            <Text style={styles.statusTitle}>Protected</Text>
            <Text style={styles.statusBody}>
              {data!.stats.callsScreened} unknown caller{data!.stats.callsScreened === 1 ? "" : "s"} screened
              today
              {data!.stats.suspectedScamsBlocked > 0
                ? `, ${data!.stats.suspectedScamsBlocked} suspected scam${data!.stats.suspectedScamsBlocked === 1 ? "" : "s"} blocked.`
                : ", all clear."}
            </Text>
          </>
        )}

        {data!.membership.status === "payment_issue" && (
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
