// C1 — Home / Protection Status. Per APP_VISUAL_SPECIFICATION.md: the
// hero screen — answers "Am I protected?" at a glance. Once setup is
// complete this should be almost entirely passive reassurance; the only
// interactive element is the conditional "finish setup" card.
//
// Visual redesign (2026-08-23, post-launch, presentation-layer only):
// the previous version answered "Am I protected?" with a plain text
// title and one line of stats — reads as a generic dashboard, not as
// Home Call Guard actively watching over you. This version leads with
// the real brand shield (cropped directly from public/logo.png, the
// same mark used on the website) and a single unmistakable headline,
// then a plain-English explanation, then a real-data protection summary,
// recent activity preview, and trusted-contacts status — all from the
// exact same DashboardResponse this screen already fetched, nothing
// invented. Every state-derivation function below (deriveLoadOutcome,
// isSettingUp, resumeSetupAt, the load()/useEffect/useFocusEffect
// wiring) is untouched from the previous version — only the JSX/styles
// changed.
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View, StyleSheet, ActivityIndicator, RefreshControl, ScrollView, Image } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { fetchDashboard, NotEntitledError } from "../../lib/api";
import { useAuth } from "../../lib/AuthContext";
import { deriveLoadOutcome, isSettingUp as computeIsSettingUp } from "../../lib/homeStatus";
import { resumeSetupAt } from "../../lib/setupFlow";
import type { DashboardActivityItem, DashboardResponse } from "../../lib/types";
import { colors, spacing, typography } from "../../lib/theme";

// "ready" is the only state in which `data` is guaranteed non-null and
// backend-confirmed for the *current* user — every other state must never
// render "Protected" or "Setting up", both of which claim knowledge about
// protection status we don't actually have. Fail closed, not open.
type ScreenState = "loading" | "ready" | "unavailable" | "not_entitled";

// Plain-English translation of the two raw fields the backend returns for
// an activity row (status: "Known"/"Unknown", result: "SAFE"/"SCAM"/null)
// — never shown as jargon, never a technical term. `isWarning` drives the
// one bit of colour-coding on the row.
function describeActivity(item: DashboardActivityItem): { label: string; isWarning: boolean } {
  if (item.status === "Known") {
    return { label: "Trusted contact called", isWarning: false };
  }
  if (item.result === "SCAM") {
    return { label: "Blocked a suspected scam call", isWarning: true };
  }
  return { label: "Checked an unknown caller — all clear", isWarning: false };
}

// Deliberately no date library dependency for one field on one screen —
// "Today, 14:32" / "12 Aug" is all this needs, and every other date
// display in this codebase already does its own plain Date formatting.
function formatActivityTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (isToday) return `Today, ${time}`;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function BrandHeader() {
  return (
    <View style={styles.brandHeader}>
      <Text style={styles.brandWordmark}>
        <Text style={styles.brandWordmarkWhite}>Home Call </Text>
        <Text style={styles.brandWordmarkGreen}>Guard</Text>
      </Text>
    </View>
  );
}

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
          <BrandHeader />
          <View style={styles.shieldWrap}>
            <View style={[styles.shieldGlow, styles.shieldGlowMuted]}>
              <Image source={require("../../assets/shield-mark.png")} style={styles.shieldImageMuted} resizeMode="contain" />
            </View>
          </View>
          <Text style={styles.giantTitle} accessibilityRole="header">Not protected yet</Text>
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
          <BrandHeader />
          <View style={styles.shieldWrap}>
            <View style={[styles.shieldGlow, styles.shieldGlowMuted]}>
              <Image source={require("../../assets/shield-mark.png")} style={styles.shieldImageMuted} resizeMode="contain" />
            </View>
          </View>
          <Text style={styles.giantTitle} accessibilityRole="header">Can't check right now</Text>
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

  const recentActivity = data!.activity.slice(0, 3);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} tintColor={colors.accent} />}
      >
        <BrandHeader />

        {isStale && <Banner variant="notice" message="You're offline — showing your last known status." />}

        {isSettingUp ? (
          <>
            <View style={styles.shieldWrap}>
              <View style={[styles.shieldGlow, styles.shieldGlowMuted]}>
                <Image source={require("../../assets/shield-mark.png")} style={styles.shieldImageMuted} resizeMode="contain" />
              </View>
            </View>
            <Text style={styles.giantTitle} accessibilityRole="header">Setting up</Text>
            <Text style={styles.statusBody}>{finishSetupBody}</Text>
            <PrimaryButton
              label={finishSetupLabel}
              onPress={() => router.push(resumeRoute as any)}
            />
          </>
        ) : (
          <>
            {/* Dominant hero: the real brand shield, large, with a soft
                glow ring so it reads as "active" rather than a static
                icon — the single most important element on this screen,
                per the design objective ("shield/protection visual as
                the dominant element rather than a generic text
                dashboard"). */}
            <View style={styles.shieldWrap}>
              <View style={styles.shieldGlow}>
                <Image source={require("../../assets/shield-mark.png")} style={styles.shieldImage} resizeMode="contain" />
              </View>
            </View>

            <Text style={styles.giantTitle} accessibilityRole="header">You're protected</Text>
            <Text style={styles.reassurance}>
              Home Call Guard is monitoring unknown callers and helping protect you from scams.
            </Text>

            {/* Real-data protection summary — no invented numbers, same
                stats.* fields the previous version already read, just
                given a scannable card treatment instead of one run-on
                sentence. */}
            <View style={styles.statRow}>
              <View style={styles.statCard}>
                <Text style={styles.statNumber}>{data!.stats.callsScreened}</Text>
                <Text style={styles.statLabel}>
                  {data!.stats.callsScreened === 1 ? "call checked today" : "calls checked today"}
                </Text>
              </View>
              <View style={[styles.statCard, data!.stats.suspectedScamsBlocked > 0 && styles.statCardWarning]}>
                <Text style={[styles.statNumber, data!.stats.suspectedScamsBlocked > 0 && styles.statNumberWarning]}>
                  {data!.stats.suspectedScamsBlocked}
                </Text>
                <Text style={styles.statLabel}>
                  {data!.stats.suspectedScamsBlocked === 1 ? "scam call stopped" : "scam calls stopped"}
                </Text>
              </View>
            </View>

            {hasNoContacts && (
              <View style={styles.nudge}>
                <Text style={styles.nudgeText}>
                  You haven't added a trusted contact yet — family and friends may be checked like an
                  unknown caller until you do.
                </Text>
                <PrimaryButton
                  label="Add a trusted contact"
                  variant="secondary"
                  onPress={() => router.push("/(setup)/contacts")}
                />
              </View>
            )}

            {/* Trusted contacts status — simple summary + link, never the
                full editable list (that's the Contacts tab's job). */}
            <View style={styles.summaryRow}>
              <Text style={styles.summaryRowLabel}>Trusted contacts</Text>
              <Text style={styles.summaryRowValue}>
                {data!.contacts.length === 0
                  ? "None yet"
                  : `${data!.contacts.length} ${data!.contacts.length === 1 ? "contact" : "contacts"}`}
              </Text>
            </View>

            {/* Recent activity preview — real rows from the same array
                the Activity tab reads, just the first few, in plain
                English (see describeActivity above), with a link to the
                full list rather than duplicating it here. */}
            <Text style={styles.sectionTitle}>Recent activity</Text>
            {recentActivity.length === 0 ? (
              <Text style={styles.emptyStateText}>No calls yet — this is where you'll see them.</Text>
            ) : (
              <View style={styles.activityList}>
                {recentActivity.map((item, index) => {
                  const { label, isWarning } = describeActivity(item);
                  return (
                    <View key={`${item.time}-${index}`} style={styles.activityRow}>
                      <View style={[styles.activityDot, isWarning && styles.activityDotWarning]} />
                      <View style={styles.activityTextWrap}>
                        <Text style={styles.activityLabel}>{label}</Text>
                        <Text style={styles.activityTime}>{formatActivityTime(item.time)}</Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
            {data!.activity.length > 0 && (
              <PrimaryButton label="See all activity" variant="secondary" onPress={() => router.push("/(tabs)/activity")} />
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

const SHIELD_SIZE = 132;

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
  brandHeader: {
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  brandWordmark: {
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  brandWordmarkWhite: {
    color: colors.text,
  },
  brandWordmarkGreen: {
    color: colors.accent,
  },
  shieldWrap: {
    alignItems: "center",
    marginBottom: spacing.md,
  },
  shieldGlow: {
    width: SHIELD_SIZE + 48,
    height: SHIELD_SIZE + 48,
    borderRadius: (SHIELD_SIZE + 48) / 2,
    backgroundColor: colors.accentMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  shieldGlowMuted: {
    backgroundColor: colors.card,
  },
  shieldImage: {
    width: SHIELD_SIZE,
    height: SHIELD_SIZE,
  },
  shieldImageMuted: {
    width: SHIELD_SIZE,
    height: SHIELD_SIZE,
    opacity: 0.5,
  },
  giantTitle: {
    ...typography.giant,
    color: colors.accent,
    textAlign: "center",
    marginBottom: spacing.sm,
  },
  reassurance: {
    ...typography.body,
    color: colors.text,
    textAlign: "center",
    marginBottom: spacing.lg,
  },
  statusBody: {
    ...typography.body,
    color: colors.text,
    textAlign: "center",
    marginBottom: spacing.lg,
  },
  statRow: {
    flexDirection: "row",
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  statCardWarning: {
    borderColor: colors.danger,
    backgroundColor: colors.dangerBackground,
  },
  statNumber: {
    fontSize: 30,
    fontWeight: "800",
    color: colors.accent,
  },
  statNumberWarning: {
    color: colors.danger,
  },
  statLabel: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: "center",
    marginTop: spacing.xs,
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.lg,
  },
  summaryRowLabel: {
    ...typography.body,
    color: colors.text,
  },
  summaryRowValue: {
    ...typography.body,
    color: colors.accent,
    fontWeight: "700",
  },
  sectionTitle: {
    ...typography.title,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  emptyStateText: {
    ...typography.body,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  activityList: {
    marginBottom: spacing.md,
  },
  activityRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  activityDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.accent,
    marginTop: 6,
    marginRight: spacing.sm,
  },
  activityDotWarning: {
    backgroundColor: colors.danger,
  },
  activityTextWrap: {
    flex: 1,
  },
  activityLabel: {
    ...typography.body,
    color: colors.text,
  },
  activityTime: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: 2,
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
