// C6 — Account. Per APP_VISUAL_SPECIFICATION.md: hub for membership,
// support, legal. No Notifications row in V1 — push notifications are
// deferred per the Launch Feature Matrix, so D2 doesn't exist yet;
// adding it back is a small, additive change once push ships.
import { useCallback, useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, ActivityIndicator, Platform } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../lib/supabase";
import { useAuth } from "../../../lib/AuthContext";
import { fetchDashboard, NotEntitledError } from "../../../lib/api";
import { resetVoiceRegistrationState } from "../../../lib/voiceClient";
import type { MembershipStatus } from "../../../lib/types";
import { colors, radius, spacing, typography, MIN_TOUCH_TARGET } from "../../../lib/theme";

const MEMBERSHIP_LABEL: Record<MembershipStatus, string> = {
  active: "Active",
  trial: "Free trial",
  payment_issue: "Payment issue",
  cancelled: "Cancelling at period end",
};

// "loading" | "no_membership" (confirmed, not an error) | "unavailable"
// (bootstrap/dashboard fetch failed — never show a guessed status) |
// "loaded" (membership + protection below are backend-confirmed).
type StatusState = "loading" | "no_membership" | "unavailable" | "loaded";

export default function Account() {
  const { session } = useAuth();
  const [email, setEmail] = useState<string | null>(null);
  const [statusState, setStatusState] = useState<StatusState>("loading");
  const [membershipStatus, setMembershipStatus] = useState<MembershipStatus | null>(null);
  const [isProtected, setIsProtected] = useState(false);

  // Identity changed (sign-out/sign-in as a different account) — clear
  // everything rather than risk showing a moment of the previous user's
  // email or status. See Priority 2/5: no cached identity or household
  // state from a previous or failed session may be shown as the current
  // user's.
  useEffect(() => {
    setEmail(null);
    setStatusState("loading");
    setMembershipStatus(null);
    setIsProtected(false);
  }, [session?.user?.id]);

  useFocusEffect(
    useCallback(() => {
      // Deliberately independent of membership/entitlement status — a
      // customer without an active subscription is still authenticated
      // and should still see their own email address here.
      supabase.auth
        .getUser()
        .then(({ data }) => setEmail(data.user?.email ?? null))
        .catch(() => {});

      fetchDashboard(session?.access_token)
        .then(result => {
          setMembershipStatus(result.membership.status);
          setIsProtected(!!result.protection.activationVerifiedAt);
          setStatusState("loaded");
        })
        .catch(err => {
          if (err instanceof NotEntitledError) {
            setMembershipStatus(null);
            setIsProtected(false);
            setStatusState("no_membership");
          } else {
            // Bootstrap or the dashboard fetch failed — must not guess or
            // retain a previously-shown status. Fail closed.
            setMembershipStatus(null);
            setIsProtected(false);
            setStatusState("unavailable");
          }
        });
    }, [session?.access_token])
  );

  // Resets voiceClient.ts's module-level registration state before
  // signing out (2026-09-07 fix) — otherwise a second household signing
  // into this same device would hit registerForIncomingCalls()'s
  // `if (registered) return` guard and silently never register under its
  // own identity. Called before the actual Supabase sign-out call below:
  // order doesn't matter functionally (resetVoiceRegistrationState only
  // touches local module state, not the session), but doing it first
  // means a slow/failed sign-out network call can never leave this step
  // skipped.
  function signOutAndResetVoiceRegistration() {
    resetVoiceRegistrationState();
    supabase.auth.signOut();
  }

  function handleLogout() {
    // Alert.alert's multi-button form is a silent no-op on React Native
    // Web (confirmed live, RC1 staging test, 2026-08-02) — the dialog
    // never renders and its callback never fires, so the button did
    // nothing at all on web. window.confirm is the reliable equivalent
    // there; native (iOS/Android) keeps the original Alert, which this
    // gap has no evidence of affecting.
    if (Platform.OS === "web") {
      if (window.confirm("Log out?")) {
        signOutAndResetVoiceRegistration();
      }
      return;
    }
    Alert.alert("Log out?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Log out",
        style: "destructive",
        onPress: signOutAndResetVoiceRegistration,
      },
    ]);
  }

  return (
    <View style={styles.container}>
      {email && (
        <View style={styles.profile}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{email.trim().charAt(0).toUpperCase()}</Text>
          </View>
          <Text style={styles.email} numberOfLines={1}>{email}</Text>
        </View>
      )}

      <View style={styles.statusBlock}>
        <StatusRow label="Membership" state={statusState} value={membershipStatus ? MEMBERSHIP_LABEL[membershipStatus] : "No active membership"} positive={membershipStatus === "active"} bordered />
        <StatusRow label="Protection" state={statusState} value={isProtected ? "Protected" : "Not yet active"} positive={isProtected} />
      </View>

      <Row icon="card-outline" label="Membership" onPress={() => router.push("/(tabs)/account/membership")} />
      <Row icon="power-outline" label="Need to turn protection off?" onPress={() => router.push("/(tabs)/account/turn-off-protection")} />
      <Row icon="help-buoy-outline" label="Support" onPress={() => router.push("/(tabs)/account/support")} />
      <Row icon="document-text-outline" label="Legal" onPress={() => router.push("/(tabs)/account/legal")} />
      <View style={styles.dangerGap} />
      <Row icon="log-out-outline" label="Log out" onPress={handleLogout} destructive />
      <Row icon="trash-outline" label="Delete Account" onPress={() => router.push("/(tabs)/account/delete-account")} destructive />
    </View>
  );
}

// Shows a spinner while loading, "Status unavailable" (never a guessed
// value) if the backend call failed for any reason other than a
// confirmed no-membership state, and the real value only once positively
// confirmed. `positive` only picks the value's colour (green when the
// confirmed value is the good one) — it never changes what is shown.
function StatusRow({
  label,
  state,
  value,
  positive,
  bordered,
}: {
  label: string;
  state: StatusState;
  value: string;
  positive?: boolean;
  bordered?: boolean;
}) {
  return (
    <View style={[styles.statusRow, bordered && styles.statusRowBordered]}>
      <Text style={styles.statusLabel}>{label}</Text>
      {state === "loading" ? (
        <ActivityIndicator color={colors.textMuted} size="small" />
      ) : state === "unavailable" ? (
        <Text style={styles.statusUnavailable}>Status unavailable</Text>
      ) : (
        <View style={styles.statusValueRow}>
          {positive && <View style={styles.statusDot} />}
          <Text style={[styles.statusValue, positive && styles.statusValuePositive]}>{value}</Text>
        </View>
      )}
    </View>
  );
}

function Row({ icon, label, onPress, destructive }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; destructive?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
    >
      <Ionicons
        name={icon}
        size={20}
        color={destructive ? colors.danger : colors.accent}
        style={styles.rowIcon}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
      <Text style={[styles.rowLabel, destructive && styles.destructiveLabel]}>{label}</Text>
      {!destructive && <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.lg,
  },
  profile: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accentSoft,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },
  avatarText: {
    color: colors.accent,
    fontSize: 18,
    fontWeight: "700",
  },
  email: {
    ...typography.body,
    color: colors.text,
    flex: 1,
  },
  statusBlock: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    marginBottom: spacing.lg,
    overflow: "hidden",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: MIN_TOUCH_TARGET + 4,
    paddingHorizontal: spacing.md,
  },
  statusRowBordered: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  statusLabel: {
    ...typography.body,
    color: colors.textMuted,
  },
  statusValueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  statusValue: {
    ...typography.body,
    color: colors.text,
    fontWeight: "600",
  },
  statusValuePositive: {
    color: colors.accent,
  },
  statusUnavailable: {
    ...typography.body,
    color: colors.textMuted,
    fontStyle: "italic",
  },
  dangerGap: {
    height: spacing.md,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: MIN_TOUCH_TARGET + 4,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    marginBottom: spacing.sm,
  },
  rowPressed: {
    borderColor: colors.accent,
  },
  rowIcon: {
    marginRight: spacing.md,
  },
  rowLabel: {
    ...typography.body,
    color: colors.text,
    flex: 1,
  },
  destructiveLabel: {
    color: colors.danger,
  },
});
