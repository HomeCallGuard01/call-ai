// C6 — Account. Per APP_VISUAL_SPECIFICATION.md: hub for membership,
// support, legal. No Notifications row in V1 — push notifications are
// deferred per the Launch Feature Matrix, so D2 doesn't exist yet;
// adding it back is a small, additive change once push ships.
import { useCallback, useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, ActivityIndicator } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { supabase } from "../../../lib/supabase";
import { useAuth } from "../../../lib/AuthContext";
import { fetchDashboard, NotEntitledError } from "../../../lib/api";
import type { MembershipStatus } from "../../../lib/types";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../../lib/theme";

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

      fetchDashboard()
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
    }, [])
  );

  function handleLogout() {
    Alert.alert("Log out?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Log out",
        style: "destructive",
        onPress: () => supabase.auth.signOut(),
      },
    ]);
  }

  return (
    <View style={styles.container}>
      {email && <Text style={styles.email}>{email}</Text>}

      <View style={styles.statusBlock}>
        <StatusRow label="Membership" state={statusState} value={membershipStatus ? MEMBERSHIP_LABEL[membershipStatus] : "No active membership"} bordered />
        <StatusRow label="Protection" state={statusState} value={isProtected ? "Protected" : "Not yet active"} />
      </View>

      <Row label="Membership" onPress={() => router.push("/(tabs)/account/membership")} />
      <Row label="Support" onPress={() => router.push("/(tabs)/account/support")} />
      <Row label="Legal" onPress={() => router.push("/(tabs)/account/legal")} />
      <Row label="Log out" onPress={handleLogout} destructive />
    </View>
  );
}

// Shows a spinner while loading, "Status unavailable" (never a guessed
// value) if the backend call failed for any reason other than a
// confirmed no-membership state, and the real value only once positively
// confirmed.
function StatusRow({
  label,
  state,
  value,
  bordered,
}: {
  label: string;
  state: StatusState;
  value: string;
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
        <Text style={styles.statusValue}>{value}</Text>
      )}
    </View>
  );
}

function Row({ label, onPress, destructive }: { label: string; onPress: () => void; destructive?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
    >
      <Text style={[styles.rowLabel, destructive && styles.destructiveLabel]}>{label}</Text>
      {!destructive && <Text style={styles.chevron}>›</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.lg,
  },
  email: {
    ...typography.caption,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  statusBlock: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.card,
    marginBottom: spacing.lg,
    overflow: "hidden",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: MIN_TOUCH_TARGET,
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
  statusValue: {
    ...typography.body,
    color: colors.text,
    fontWeight: "600",
  },
  statusUnavailable: {
    ...typography.body,
    color: colors.textMuted,
    fontStyle: "italic",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.card,
    marginBottom: spacing.sm,
  },
  rowPressed: {
    borderColor: colors.accent,
  },
  rowLabel: {
    ...typography.body,
    color: colors.text,
  },
  destructiveLabel: {
    color: colors.danger,
  },
  chevron: {
    color: colors.textMuted,
    fontSize: 20,
  },
});
