// C1 — Home / Protection Status. Per APP_VISUAL_SPECIFICATION.md: the
// hero screen — answers "Am I protected?" at a glance. Once setup is
// complete this should be almost entirely passive reassurance; the only
// interactive element is the conditional "finish setup" card.
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View, StyleSheet, ActivityIndicator, RefreshControl, ScrollView } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { fetchDashboard, NotEntitledError } from "../../lib/api";
import { useAuth } from "../../lib/AuthContext";
import { deriveLoadOutcome, isSettingUp as computeIsSettingUp } from "../../lib/homeStatus";
import { resumeSetupAt } from "../../lib/setupFlow";
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

  // load() is triggered from two independent sources — useFocusEffect
  // (every time this tab regains focus) and pull-to-refresh — so two
  // calls can genuinely overlap (e.g. pull-to-refresh started, then the
  // user switches tabs and back before it resolves). Without this, a
  // slow earlier response landing after a faster later one would
  // silently overwrite fresher state with stale state, and an earlier
  // call's `finally` could clear isRefreshing while a newer refresh is
  // still in flight. Only the most recently started call is allowed to
  // touch state.
  const loadId = useRef(0);

  // Identity changed (sign-out/sign-in as a different account, or session
  // lost) — any previously-loaded data belonged to a different user and
  // must never be shown as this user's status, even for an instant while
  // the next load() is in flight. See Priority 5/2: no cached household
  // state from a previous or failed session may be attributed to the
  // current user.
  useEffect(() => {
    // Bump loadId here too, not only inside load() itself: an in-flight
    // request started under the previous identity has no way to know the
    // session changed underneath it, and without this its response would
    // still pass the "am I the latest call" check below and write the
    // previous user's data into the newly-reset state.
    loadId.current++;
    setData(null);
    setIsStale(false);
    setState("loading");
  }, [session?.user?.id]);

  const load = useCallback(async (isRefresh = false) => {
    const thisLoadId = ++loadId.current;
    if (isRefresh) setIsRefreshing(true);
    let succeeded = false;
    let isNotEntitledError = false;
    let result: DashboardResponse | null = null;

    try {
      result = await fetchDashboard();
      succeeded = true;
    } catch (err) {
      isNotEntitledError = err instanceof NotEntitledError;
    }

    // A newer load() call started (and possibly already resolved) while
    // this one was in flight — this result is stale, discard it rather
    // than let it clobber more recent state or spuriously clear the
    // refresh spinner for a refresh that's still running.
    if (thisLoadId !== loadId.current) return;

    setIsRefreshing(false);

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
          <Text style={styles.statusTitle} accessibilityRole="header">Action needed</Text>
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
          <Text style={styles.statusTitle} accessibilityRole="header">Protection status unavailable</Text>
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
  const hasNoContacts = data!.contacts.length === 0;

  // Same decision point B1 uses to skip already-done steps — reused here
  // so "Finish setup" always sends the customer to the actual next
  // unfinished step (which, since contacts now come before activation,
  // is often contacts, not device-picker), rather than a hardcoded
  // screen that assumes the old step order.
  const resumeTarget = resumeSetupAt({
    isEntitled: true,
    contactCount: data!.contacts.length,
    isActivationVerified: !!data!.protection.activationVerifiedAt,
  });
  // No "subscribe" entry: `isEntitled: true` above is hardcoded, not
  // read from `data`, because `state === "ready"` is only reachable once
  // deriveLoadOutcome has confirmed entitlement (its own tests assert a
  // not_entitled result always wins over stale prior data) — so
  // resumeTarget.screen can never legitimately be "subscribe" here. The
  // fallback below exists purely so that if that invariant is ever
  // broken by a future change, this button navigates somewhere sane
  // instead of silently calling router.push(undefined).
  const RESUME_ROUTE: Record<string, string> = {
    contacts: "/(setup)/contacts",
    "device-picker": "/(setup)/device-picker",
    complete: "/(setup)/complete",
  };
  const resumeRoute = RESUME_ROUTE[resumeTarget.screen] ?? "/(setup)/welcome";
  const finishSetupLabel = resumeTarget.screen === "contacts" ? "Add trusted contacts" : "Finish setup";
  const finishSetupBody =
    resumeTarget.screen === "contacts"
      ? "Add at least one trusted contact, then turn on call forwarding to complete your protection."
      : "Finish activating call forwarding to complete your protection.";

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} tintColor={colors.accent} />}
      >
        {isStale && <Banner variant="notice" message="You're offline — showing your last known status." />}

        {isSettingUp ? (
          <>
            <Text style={styles.statusTitle} accessibilityRole="header">Setting up</Text>
            <Text style={styles.statusBody}>{finishSetupBody}</Text>
            <PrimaryButton
              label={finishSetupLabel}
              onPress={() => router.push(resumeRoute as any)}
            />
          </>
        ) : (
          <>
            <Text style={styles.statusTitle} accessibilityRole="header">Protected</Text>
            <Text style={styles.statusBody}>
              {data!.stats.callsScreened} unknown caller{data!.stats.callsScreened === 1 ? "" : "s"} screened
              today
              {data!.stats.suspectedScamsBlocked > 0
                ? `, ${data!.stats.suspectedScamsBlocked} suspected scam${data!.stats.suspectedScamsBlocked === 1 ? "" : "s"} blocked.`
                : ", all clear."}
            </Text>

            {hasNoContacts && (
              <View style={styles.nudge}>
                <Text style={styles.nudgeText}>
                  You haven't added a trusted contact yet — family and friends may be screened like an
                  unknown caller until you do.
                </Text>
                <PrimaryButton
                  label="Add a trusted contact"
                  variant="secondary"
                  onPress={() => router.push("/(setup)/contacts")}
                />
              </View>
            )}
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
  nudge: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.card,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  nudgeText: {
    ...typography.body,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
});
