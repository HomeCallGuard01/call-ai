// C6 — Account. Per APP_VISUAL_SPECIFICATION.md: hub for membership,
// support, legal. No Notifications row in V1 — push notifications are
// deferred per the Launch Feature Matrix, so D2 doesn't exist yet;
// adding it back is a small, additive change once push ships.
import { useCallback, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { fetchDashboard } from "../../../lib/api";
import { supabase } from "../../../lib/supabase";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../../lib/theme";

export default function Account() {
  const [email, setEmail] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      fetchDashboard()
        .then(() => supabase.auth.getUser())
        .then(({ data }) => setEmail(data.user?.email ?? null))
        .catch(() => {});
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

      <Row label="Membership" onPress={() => router.push("/(tabs)/account/membership")} />
      <Row label="Support" onPress={() => router.push("/(tabs)/account/support")} />
      <Row label="Legal" onPress={() => router.push("/(tabs)/account/legal")} />
      <Row label="Log out" onPress={handleLogout} destructive />
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
