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
// invented.
//
// Onboarding-verification UX change (2026-09-23): computeHomeProtectionState
// and resumeSetupAt now also take a local, per-device "setup completed"
// signal (lib/setupCompletionStorage.ts) alongside the backend-confirmed
// data — see lib/homeStatus.ts's own comment for the new
// "awaiting_confirmation" state this adds, and lib/setupFlow.ts's for why
// resumeSetupAt needed it too.
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View, StyleSheet, ActivityIndicator, RefreshControl, ScrollView, Image, Pressable, Linking, AppState, Platform } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { CallReadinessBanner } from "../../components/CallReadinessBanner";
import { BrandMark } from "../../components/BrandMark";
import { OutcomeRow, type OutcomeTone } from "../../components/OutcomeRow";
import { EmptyState } from "../../components/EmptyState";
import { AllowanceMeter } from "../../components/AllowanceMeter";
import { AllowanceStatusBanner } from "../../components/AllowanceStatusBanner";
import { parseAllowanceState, suppressesProtected, allowanceHeroBody, describeAllowanceBanner } from "../../lib/allowanceState";
import { Ionicons } from "@expo/vector-icons";
import { fetchDashboard, fetchActivationDevice, NotEntitledError } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/AuthContext";
import { deriveLoadOutcome, hasProvenActivation } from "../../lib/homeStatus";
import { describeProtection, buildSetupChecklist, isServerProtected, describeMembership, type ProtectionAction } from "../../lib/protectionView";
import { ProtectionChecklist } from "../../components/ProtectionChecklist";
import { getCallReadiness } from "../../lib/callReadiness";
import { canPresentCalls, readinessMessage, readinessProblem } from "../../lib/callReadinessModel";
import { classifyLoadFailure, type LoadFailureReason } from "../../lib/loadFailure";
import { getActiveCall, registerForIncomingCalls, resetVoiceRegistrationState, unregisterForIncomingCalls } from "../../lib/voiceClient";
import { resumeSetupAt } from "../../lib/setupFlow";
import { loadSetupCompletedAt, clearSetupCompletedAt } from "../../lib/setupCompletionStorage";
import type { DashboardActivityItem, DashboardResponse } from "../../lib/types";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../lib/theme";

// "ready" is the only state in which `data` is guaranteed non-null and
// backend-confirmed for the *current* user — every other state must never
// render "Protected" or "Setting up", both of which claim knowledge about
// protection status we don't actually have. Fail closed, not open.
type ScreenState = "loading" | "ready" | "unavailable" | "not_entitled";

// Plain-English translation of the raw fields the backend returns for an
// activity row (status: "Known"/"Unknown", result: "SAFE"/"SCAM"/null,
// terminatedBySystem: boolean) — never shown as jargon, never a technical
// term, never the actual detection signal/keywords. `isWarning` drives
// the one bit of colour-coding on the row.
//
// terminatedBySystem is checked BEFORE result (2026-09-13 fix): a call
// live monitoring stopped mid-call for detected risk still has
// result: "SAFE" (the pre-monitoring optimistic value — see backend's
// database/calls.js recordMonitoringOutcome, which deliberately never
// rewrites result), so checking result alone previously mislabelled a
// genuinely-stopped high-risk call as "all clear". Missing/undefined
// terminatedBySystem (a historic row, or an older cached response) is
// treated the same as false — falls through to the existing checks
// exactly as before this fix.
function describeActivity(item: DashboardActivityItem): { label: string; isWarning: boolean } {
  if (item.status === "Known") {
    return { label: "Trusted contact called", isWarning: false };
  }
  if (item.terminatedBySystem === true) {
    return { label: "High risk — call stopped", isWarning: true };
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

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function BrandHeader() {
  return <BrandMark size="md" />;
}

// The dominant hero: the real brand shield inside two soft rings. Green
// rings = actively protected; grey = anything short of that (setting up,
// confirming, reconnecting, not entitled, or a load problem) — so
// "protected" is visually unmistakable and never implied by a state that
// isn't. Presentation only: which one renders is decided by the same
// state checks as before.
// 1.0.2: a third, amber ring treatment for "needs attention" — still never
// the green "protected" look.
function Hero({ muted = false, attention = false }: { muted?: boolean; attention?: boolean }) {
  return (
    <View style={styles.shieldWrap} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.ringOuter, muted && styles.ringOuterMuted, attention && styles.ringOuterAttention]}>
        <View style={[styles.ringInner, muted && styles.ringInnerMuted, attention && styles.ringInnerAttention]}>
          <Image
            source={require("../../assets/shield-mark.png")}
            style={muted ? styles.shieldImageMuted : styles.shieldImage}
            resizeMode="contain"
          />
        </View>
      </View>
    </View>
  );
}

// Trusted contact -> neutral, high risk -> amber, everything else screened
// clear -> green: the app's three real outcomes, derived from the same
// describeActivity result the row label already comes from.
function toneFor(item: DashboardActivityItem, isWarning: boolean): OutcomeTone {
  if (item.status === "Known") return "neutral";
  return isWarning ? "warning" : "positive";
}

export default function Home() {
  const { session } = useAuth();
  const [state, setState] = useState<ScreenState>("loading");
  const [data, setData] = useState<DashboardResponse | null>(null);
  // Only meaningful while state === "unavailable" — see lib/loadFailure.ts.
  // Defaults to "network_error" so an unset value never accidentally
  // claims a session problem that wasn't actually classified.
  const [unavailableReason, setUnavailableReason] = useState<LoadFailureReason>("network_error");
  // True when `data` is from a previous successful load and the most
  // recent refresh attempt failed — distinct from "unavailable" (no
  // confirmed data has ever existed for this session). Only this case
  // is allowed to keep showing last-known status (per E3: a connectivity
  // blip must never look like a protection problem) — it can only ever
  // become true from a state that already had real data.
  const [isStale, setIsStale] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Local-device-only, per household — see lib/setupCompletionStorage.ts.
  // null means either "never completed setup on this device" (a genuine
  // setting_up household) or "not loaded yet" (loading state); both
  // correctly fall back to today's existing setting_up behaviour below.
  const [setupCompletedAt, setSetupCompletedAt] = useState<string | null>(null);
  // Complimentary/admin-account onboarding fix (2026-09-24) — see
  // lib/setupFlow.ts's own comment. Defaults to true ("assume on record")
  // for the same reason resumeSetupAt's own default does: a load failure
  // or not-yet-loaded state must never manufacture a nudge that isn't
  // genuinely known to be needed.
  const [hasDeviceOnRecord, setHasDeviceOnRecord] = useState(true);
  // This phone's ability to ring for a protected call (microphone /
  // notification permission). Unknown is treated as able — only a definite
  // denial changes the hero (lib/callReadinessModel.ts canPresentCalls).
  const [deviceCanPresentCalls, setDeviceCanPresentCalls] = useState(true);
  const [deviceProblemMessage, setDeviceProblemMessage] = useState<string | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectNote, setReconnectNote] = useState<string | null>(null);

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
    // setupCompletedAt is per-household (see setupCompletionStorage.ts);
    // clearing it here matches the identity-change reset applied to
    // every other piece of this screen's state.
    setSetupCompletedAt(null);
  }, [session?.user?.id]);

  const load = useCallback(async (isRefresh = false) => {
    const thisLoadId = ++loadId.current;
    if (isRefresh) setIsRefreshing(true);
    let succeeded = false;
    let isNotEntitledError = false;
    let failureReason: LoadFailureReason = "network_error";
    let result: DashboardResponse | null = null;

    try {
      result = await fetchDashboard(session?.access_token);
      succeeded = true;
    } catch (err) {
      isNotEntitledError = err instanceof NotEntitledError;
      // classifyLoadFailure never needs to run for a NotEntitledError —
      // that's already its own distinct outcome below, unrelated to
      // "can't check right now" wording.
      if (!isNotEntitledError) failureReason = classifyLoadFailure(err);
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
    const outcome = deriveLoadOutcome({ succeeded, isNotEntitledError, hadPriorData: !!data, failureReason });

    if (outcome.kind === "has_data") {
      if (succeeded) setData(result);
      setIsStale(outcome.isStale);
      setState("ready");
    } else if (outcome.kind === "not_entitled") {
      setData(null);
      setState("not_entitled");
    } else {
      setIsStale(false);
      setUnavailableReason(outcome.reason);
      setState("unavailable");
    }
  }, [data, session?.access_token]);

  // Session-expiry recovery (2026-09-20): a real, expired/invalid session
  // must send the customer to sign in again, not just retry the same
  // failing request — see the "unavailable" render branch below. Clears
  // the stale session explicitly rather than relying on any implicit
  // auth-state-driven navigation elsewhere in the app, so this stays a
  // single, explicit, user-initiated action (matching the existing "Try
  // again" button's pattern) instead of an automatic sign-out that could
  // fire unexpectedly on a merely-transient failure — classifyLoadFailure
  // only ever returns "session_expired" for a genuine 401 from our own
  // backend, never for a network error.
  //
  // resetVoiceRegistrationState() first, synchronously, matching the
  // exact established sign-out pattern (account/index.tsx's own
  // signOutAndResetVoiceRegistration) — a stale "already registered" flag
  // must never survive into whatever session comes next after signing
  // back in.
  // 2026-09-29: unregister the push binding first (bounded; the retained
  // registration token works even though the HCG session has expired).
  function handleSessionExpired() {
    unregisterForIncomingCalls().finally(() => {
      resetVoiceRegistrationState();
      clearSetupCompletedAt();
      supabase.auth.signOut().finally(() => {
        router.replace("/(auth)/login");
      });
    });
  }

  const refreshDeviceReadiness = useCallback(() => {
    getCallReadiness()
      .then(r => {
        setDeviceCanPresentCalls(canPresentCalls(r));
        setDeviceProblemMessage(readinessMessage(readinessProblem(r), Platform.OS === "ios" ? "ios" : "android"));
      })
      .catch(() => {
        setDeviceCanPresentCalls(true);
        setDeviceProblemMessage(null);
      });
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener("change", s => {
      if (s === "active") refreshDeviceReadiness();
    });
    return () => sub.remove();
  }, [refreshDeviceReadiness]);

  // "Reconnect this phone" (1.0.2): the action for the September-incident
  // state — forwarding works but this phone isn't registered to receive
  // calls. Clears only the app's local "already registered" flag so the
  // existing, unchanged registration path (lib/voiceClient.ts) runs again
  // for the SAME signed-in household, then re-reads the server's verdict.
  // Never runs during a call. Whether it worked is decided by the server's
  // next response, not assumed here.
  async function reconnectThisPhone() {
    if (getActiveCall()) return;
    setIsReconnecting(true);
    setReconnectNote(null);
    resetVoiceRegistrationState();
    try {
      await registerForIncomingCalls(session?.access_token);
    } catch {
      setReconnectNote("We couldn't reconnect this phone just now. Check your connection and try again.");
    }
    refreshDeviceReadiness();
    await load(true);
    setIsReconnecting(false);
  }

  useFocusEffect(
    useCallback(() => {
      load();
      refreshDeviceReadiness();
      // Re-read on every focus, not just once on mount — this screen is
      // reached right after complete.tsx writes this timestamp for the
      // first time, and a stale in-memory null would otherwise show
      // "Setting up"/send the customer through device-picker for one
      // extra visit before the next unrelated re-render happened to
      // catch up.
      loadSetupCompletedAt().then(setSetupCompletedAt);
      // Complimentary/admin-account onboarding fix (2026-09-24): same
      // server-authoritative endpoint the Account tab already uses —
      // fails open (assumes on record) rather than ever showing a nudge
      // on an uncertain read.
      fetchActivationDevice(session?.access_token)
        .then(d => setHasDeviceOnRecord(!!d.deviceType))
        .catch(() => setHasDeviceOnRecord(true));
    }, [load, refreshDeviceReadiness, session?.access_token])
  );

  if (state === "loading") {
    return (
      <SafeAreaView style={styles.centeredSafeArea}>
        <BrandMark size="lg" />
        <ActivityIndicator color={colors.accent} size="large" />
      </SafeAreaView>
    );
  }

  if (state === "not_entitled") {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.content}>
          <BrandHeader />
          <Hero muted />
          <Text style={[styles.headline, styles.headlineNeutral]} accessibilityRole="header">FINISH SETTING UP PROTECTION</Text>
          <Text style={styles.statusBody}>
            You don't currently have an active membership. Start your membership to protect this phone
            from scam callers.
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
          <Hero muted />
          {unavailableReason === "session_expired" ? (
            <>
              <Text style={styles.giantTitleMuted} accessibilityRole="header">Please sign in again</Text>
              <Text style={styles.statusBody}>
                Your session has expired. Sign in again to see your protection status.
              </Text>
              <PrimaryButton label="Sign in" onPress={handleSessionExpired} />
            </>
          ) : unavailableReason === "server_error" ? (
            <>
              <Text style={styles.giantTitleMuted} accessibilityRole="header">Temporary problem</Text>
              <Text style={styles.statusBody}>
                Home Call Guard is having a temporary problem on our end. Your protection isn't affected —
                please try again in a moment.
              </Text>
              <PrimaryButton label="Try again" onPress={() => load()} />
            </>
          ) : (
            <>
              <Text style={styles.giantTitleMuted} accessibilityRole="header">Can't check right now</Text>
              <Text style={styles.statusBody}>
                We couldn't confirm your protection status. Check your connection and try again.
              </Text>
              <PrimaryButton label="Try again" onPress={() => load()} />
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // state === "ready" from here on — `data` is guaranteed non-null and
  // was positively confirmed by the backend for the current user (or is
  // the last such confirmation, with isStale flagging that explicitly).
  const hasCompletedActivationStep = !!setupCompletedAt;
  const hasNoContacts = data!.contacts.length === 0;

  // Same decision point B1 uses to skip already-done steps — reused here
  // so "Finish setup" always sends the customer to the actual next
  // unfinished step (which, since contacts now come before activation,
  // is often contacts, not device-picker), rather than a hardcoded
  // screen that assumes the old step order.
  const resumeTarget = resumeSetupAt({
    isEntitled: true,
    contactCount: data!.contacts.length,
    isActivationProven: hasProvenActivation(data!),
    hasCompletedActivationStep,
    hasDeviceOnRecord,
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
    "confirm-device": "/(setup)/device-picker?confirm=1",
    complete: "/(setup)/complete",
  };
  const resumeRoute = RESUME_ROUTE[resumeTarget.screen] ?? "/(setup)/welcome";
  const finishSetupLabel = resumeTarget.screen === "contacts" ? "Add trusted contacts" : "Finish setup";
  const finishSetupBody =
    resumeTarget.screen === "contacts"
      ? "Add at least one trusted contact, then turn on call forwarding to complete your protection."
      : "Finish activating call forwarding to complete your protection.";
  // Complimentary/admin-account onboarding fix (2026-09-24): only ever
  // true once resumeTarget has already resolved past every real setup
  // step (entitled, has contacts, activation proven/completed) — the
  // household is genuinely, evidence-based set up; this is purely a
  // missing piece of support information, never shown as if protection
  // itself were in question. Deliberately separate from
  // homeProtectionState's own rendering below, not folded into it.
  const showConfirmDeviceNudge = resumeTarget.screen === "confirm-device";

  const recentActivity = data!.activity.slice(0, 3);

  // 1.0.2 (2026-10-04): the whole hero — headline, explanation and the one
  // next action — comes from lib/protectionView.ts, which only words what
  // the server's canonical state (activationStage / protectionBlockers /
  // fullyProtected) already decided. See that file's header for the rules
  // it guarantees, including the September incident (calls reached HCG,
  // the app was never registered, the customer was told nothing).
  // WS3 (2026-10-10): WS2's allowanceState, read tolerantly — missing or
  // unknown → null → everything below behaves exactly as before. When it
  // says unknown callers aren't being checked, the hero never says
  // "Protected" (allowanceSuppression) and the banner explains why.
  const allowanceState = parseAllowanceState(data);
  const protectionInput = {
    protection: data!.protection,
    membership: data!.membership,
    testPurchase: data!.customerAllowance?.membership?.testPurchase === true,
    allowance: data!.customerAllowance ?? null,
    allowanceSuppression: allowanceState && suppressesProtected(allowanceState) ? { body: allowanceHeroBody(allowanceState) } : null,
  };
  const view = describeProtection(protectionInput, {
    canPresentCalls: deviceCanPresentCalls,
    problemMessage: deviceProblemMessage,
    hasCompletedActivationStep,
  });
  const checklist = buildSetupChecklist(protectionInput);
  const serverProtected = isServerProtected(protectionInput);
  // Only once calls are actually flowing through HCG (protected, or calls
  // arriving with forwarding not yet proven) is an allowance banner relevant.
  const allowanceBanner =
    serverProtected || data!.protection.activationStage === "forwarding_unconfirmed"
      ? describeAllowanceBanner(allowanceState, Platform.OS)
      : null;
  const membershipView = describeMembership(
    {
      status: data!.membership.status,
      accessUntil: data!.membership.accessUntil,
      trialEndDate: data!.membership.trialEndDate,
      complimentary: data!.customerAllowance?.membership?.state === "complimentary",
      testPurchase: protectionInput.testPurchase,
    },
    formatShortDate
  );
  // Before forwarding has ever been attempted on this device the guided flow
  // (contacts -> device-picker) is the right place; afterwards (including the
  // old-number case) the standalone forwarding screen is.
  const forwardingRoute =
    resumeTarget.screen === "contacts" || resumeTarget.screen === "device-picker" ? resumeRoute : "/(tabs)/account/set-up-call-forwarding";

  function runAction(kind: ProtectionAction) {
    switch (kind) {
      case "reconnect_app":
        reconnectThisPhone();
        return;
      case "open_settings":
        Linking.openSettings().catch(() => {});
        return;
      case "set_up_forwarding":
        router.push(forwardingRoute as any);
        return;
      case "resume_setup":
        router.push(resumeRoute as any);
        return;
      case "update_payment":
        router.push("/(tabs)/membership");
        return;
      case "contact_support":
        router.push("/(tabs)/account/support");
        return;
      case "refresh":
        load(true);
        return;
    }
  }

  const headlineStyle =
    view.tone === "protected" ? styles.headlineProtected : view.tone === "attention" ? styles.headlineAttention : styles.headlineNeutral;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} tintColor={colors.accent} />}
      >
        <BrandHeader />

        {isStale && <Banner variant="notice" message="You're offline — showing your last known status." />}

        {/* 2026-09-30: this phone cannot ring for protected calls (a
            microphone/notification permission is off). Since 1.0.2 the hero
            itself says so and offers Open Settings; the banner still covers
            the iOS "not asked yet" microphone explainer. */}
        {view.action?.kind !== "open_settings" && <CallReadinessBanner />}

        <Hero muted={!view.isProtected} attention={view.tone === "attention"} />
        <Text style={[styles.headline, headlineStyle]} accessibilityRole="header">
          {view.headline}
        </Text>
        <Text style={styles.statusBody}>{view.body}</Text>
        {view.action && (
          <PrimaryButton label={view.action.label} onPress={() => runAction(view.action!.kind)} loading={isReconnecting} />
        )}
        {reconnectNote && <Banner variant="notice" message={reconnectNote} />}

        {/* WS3 (2026-10-10): screening low / paused / calls may stop /
            ceiling — with the honest "Turn off call forwarding" path. */}
        <AllowanceStatusBanner banner={allowanceBanner} />

        {/* Protection-status wording precision (2026-09-24): a quiet,
            honest "when was this last genuinely confirmed" fact — never a
            claim that carrier forwarding is currently, actively known to be
            on (HCG cannot observe that). */}
        {view.isProtected && data!.protection.lastConfirmedProtectedAt && (
          <Text style={styles.lastConfirmedText}>
            Last confirmed {formatActivityTime(data!.protection.lastConfirmedProtectedAt)}
          </Text>
        )}

        {/* Setup progress (Task 5) — shown whenever this phone is not fully
            protected and the server could establish its state. Every tick
            is a server gate. */}
        {!view.isProtected && view.tone !== "unknown" && <ProtectionChecklist steps={checklist} />}

        {serverProtected && (
          <>
            {/* Real-data protection summary — no invented numbers. */}
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
            <AllowanceMeter allowance={data!.customerAllowance} />
          </>
        )}

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

        {/* At-a-glance answers: who gets straight through, and what my
            membership is — each a link to its own tab. */}
        <View style={styles.summaryBlock}>
          <SummaryRow
            icon="people"
            label="Trusted contacts"
            value={data!.contacts.length === 0 ? "None yet" : `${data!.contacts.length} ${data!.contacts.length === 1 ? "contact" : "contacts"}`}
            onPress={() => router.push("/(tabs)/contacts")}
            bordered
          />
          <SummaryRow
            icon="card"
            label="Membership"
            value={membershipView.label.split(" — ")[0]}
            warning={membershipView.tone === "warning"}
            onPress={() => router.push("/(tabs)/membership")}
          />
        </View>

        {data!.membership.status === "payment_issue" && view.action?.kind !== "update_payment" && (
          <Banner
            variant="error"
            message="There's a problem with your payment. Please update your billing details to keep your protection active."
          />
        )}

        {/* Recent activity preview — real rows, plain English. */}
        {(serverProtected || data!.activity.length > 0) && (
          <>
            <Text style={styles.sectionTitle}>Recent activity</Text>
            {recentActivity.length === 0 ? (
              <View style={styles.emptyWrap}>
                <EmptyState icon="time-outline" message="No calls yet — this is where you'll see them." />
              </View>
            ) : (
              <View style={styles.activityList}>
                {recentActivity.map((item, index) => {
                  const { label, isWarning } = describeActivity(item);
                  return (
                    <OutcomeRow
                      key={`${item.time}-${index}`}
                      tone={toneFor(item, isWarning)}
                      title={label}
                      subtitle={formatActivityTime(item.time)}
                      compact
                    />
                  );
                })}
              </View>
            )}
            {data!.activity.length > 0 && (
              <PrimaryButton label="See all activity" variant="secondary" onPress={() => router.push("/(tabs)/activity")} />
            )}
          </>
        )}

        {/* Complimentary/admin-account onboarding fix (2026-09-24): a
            friendly, clearly-secondary nudge — only once every real setup
            step is done, and never claims protection is in question. */}
        {showConfirmDeviceNudge && (
          <View style={styles.nudge}>
            <Text style={styles.nudgeText}>
              Help us support your protection — confirm your phone and network. This doesn't change anything about
              your existing protection.
            </Text>
            <PrimaryButton
              label="Confirm your phone and network"
              variant="secondary"
              onPress={() => router.push(resumeRoute as any)}
            />
          </View>
        )}

        {/* Setup steps (1.0.2): the same canonical five-step list as the
            checklist above — supplementary detail, never the primary call to
            action on this screen. */}
        <Text style={styles.protectionStatusLinkRow}>
          <Text style={styles.lastConfirmedLink} onPress={() => router.push("/(setup)/protection-status")}>
            See setup steps
          </Text>
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function SummaryRow({
  icon,
  label,
  value,
  onPress,
  bordered,
  warning,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  onPress: () => void;
  bordered?: boolean;
  warning?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.summaryRow, bordered && styles.summaryRowBordered, pressed && styles.summaryRowPressed]}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
    >
      <Ionicons name={icon} size={20} color={colors.accent} style={styles.summaryIcon} accessibilityElementsHidden importantForAccessibility="no" />
      <Text style={styles.summaryRowLabel}>{label}</Text>
      <Text style={[styles.summaryRowValue, warning && styles.summaryRowValueWarning]}>{value}</Text>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} accessibilityElementsHidden importantForAccessibility="no" />
    </Pressable>
  );
}

const SHIELD_SIZE = 120;

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
    gap: spacing.lg,
  },
  content: {
    padding: spacing.lg,
    flexGrow: 1,
  },
  shieldWrap: {
    alignItems: "center",
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  ringOuter: {
    width: SHIELD_SIZE + 84,
    height: SHIELD_SIZE + 84,
    borderRadius: (SHIELD_SIZE + 84) / 2,
    backgroundColor: colors.accentGlow,
    alignItems: "center",
    justifyContent: "center",
  },
  ringOuterMuted: {
    backgroundColor: colors.neutralSoft,
  },
  ringOuterAttention: {
    backgroundColor: colors.dangerSoft,
  },
  ringInner: {
    width: SHIELD_SIZE + 44,
    height: SHIELD_SIZE + 44,
    borderRadius: (SHIELD_SIZE + 44) / 2,
    backgroundColor: colors.accentMuted,
    borderWidth: 1,
    borderColor: colors.accentDeep,
    alignItems: "center",
    justifyContent: "center",
  },
  ringInnerMuted: {
    backgroundColor: colors.card,
    borderColor: colors.border,
  },
  ringInnerAttention: {
    borderColor: colors.danger,
  },
  // 1.0.2 hero headline: upper-case, one line per state.
  headline: {
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: 0.4,
    textAlign: "center",
    marginBottom: spacing.sm,
  },
  headlineProtected: {
    color: colors.accent,
  },
  headlineAttention: {
    color: colors.danger,
  },
  headlineNeutral: {
    color: colors.text,
  },
  shieldImage: {
    width: SHIELD_SIZE,
    height: SHIELD_SIZE,
  },
  shieldImageMuted: {
    width: SHIELD_SIZE,
    height: SHIELD_SIZE,
    opacity: 0.45,
  },
  giantTitle: {
    ...typography.giant,
    color: colors.accent,
    textAlign: "center",
    marginBottom: spacing.sm,
  },
  giantTitleMuted: {
    ...typography.giant,
    color: colors.text,
    textAlign: "center",
    marginBottom: spacing.sm,
  },
  reassurance: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: "center",
    lineHeight: 23,
    marginBottom: spacing.lg,
  },
  lastConfirmedText: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: "center",
    marginTop: -spacing.sm,
    marginBottom: spacing.lg,
  },
  lastConfirmedLink: {
    color: colors.accent,
    fontWeight: "600",
  },
  protectionStatusLinkRow: {
    ...typography.caption,
    textAlign: "center",
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  statusBody: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: "center",
    lineHeight: 23,
    marginBottom: spacing.lg,
  },
  statRow: {
    flexDirection: "row",
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.sm,
    alignItems: "center",
  },
  statCardWarning: {
    borderColor: colors.danger,
    backgroundColor: colors.dangerBackground,
  },
  statNumber: {
    fontSize: 36,
    fontWeight: "800",
    letterSpacing: -0.5,
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
  summaryBlock: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.lg,
    overflow: "hidden",
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: MIN_TOUCH_TARGET + 4,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  summaryRowBordered: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  summaryRowPressed: {
    backgroundColor: colors.cardElevated,
  },
  summaryIcon: {
    marginRight: spacing.sm,
  },
  summaryRowLabel: {
    ...typography.body,
    color: colors.text,
    flex: 1,
  },
  summaryRowValue: {
    ...typography.body,
    color: colors.accent,
    fontWeight: "700",
    marginRight: spacing.xs,
  },
  summaryRowValueWarning: {
    color: colors.danger,
  },
  sectionTitle: {
    ...typography.title,
    color: colors.text,
    marginBottom: spacing.md,
  },
  emptyWrap: {
    paddingVertical: spacing.lg,
  },
  activityList: {
    marginBottom: spacing.sm,
  },
  nudge: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 16,
    backgroundColor: colors.card,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  nudgeText: {
    ...typography.body,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
});
