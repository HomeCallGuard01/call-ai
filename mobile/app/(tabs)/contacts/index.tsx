// C2 — Trusted Contacts list. Per APP_VISUAL_SPECIFICATION.md: explicit
// tap-to-delete (with confirmation) as the always-visible, reliable
// method — per the revised UX_REVIEW_PERSONAS.md guidance, never
// swipe-only. (Swipe-to-delete as an additional gesture is a reasonable
// future enhancement, not shipped in this pass — the requirement this
// satisfies is "never swipe-only," which an explicit, always-visible
// button already does on its own.)
import { useCallback, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, Alert, ActivityIndicator } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { PrimaryButton } from "../../../components/PrimaryButton";
import { Screen } from "../../../components/Screen";
import { fetchDashboard, deleteContact as apiDeleteContact, NotEntitledError } from "../../../lib/api";
import { useAuth } from "../../../lib/AuthContext";
import type { DashboardContact } from "../../../lib/types";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../../lib/theme";

export default function ContactsList() {
  const { session } = useAuth();
  const [contacts, setContacts] = useState<DashboardContact[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notEntitled, setNotEntitled] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchDashboard(session?.access_token);
      setContacts(data.contacts);
      setNotEntitled(false);
    } catch (err) {
      if (err instanceof NotEntitledError) {
        // Distinct from a genuinely empty list — without this, a lapsed
        // or not-yet-subscribed customer sees "No trusted contacts yet",
        // which reads as data loss rather than a membership problem.
        setNotEntitled(true);
      } else {
        setContacts(c => c ?? []);
      }
    } finally {
      setIsLoading(false);
    }
  }, [session?.access_token]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  function confirmDelete(contact: DashboardContact) {
    Alert.alert(
      "Delete contact?",
      `Remove ${contact.name} from your trusted contacts?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            await apiDeleteContact(contact.id, session?.access_token);
            load();
          },
        },
      ]
    );
  }

  if (isLoading) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} size="large" />
        </View>
      </Screen>
    );
  }

  if (notEntitled) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <Text style={styles.emptyText}>
            Start your protection to add and manage trusted contacts.
          </Text>
          <View style={styles.notEntitledButton}>
            <PrimaryButton label="Start protection" onPress={() => router.push("/(setup)/welcome")} />
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={contacts}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              No trusted contacts yet — add the people you don't want screened.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Pressable
              style={styles.rowMain}
              onPress={() => router.push({ pathname: "/(tabs)/contacts/add", params: { id: item.id, name: item.name, number: item.number } })}
              accessibilityRole="button"
            >
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.number}>{item.number}</Text>
            </Pressable>
            <Pressable
              style={styles.deleteButton}
              onPress={() => confirmDelete(item)}
              accessibilityRole="button"
              accessibilityLabel={`Delete ${item.name}`}
            >
              <Text style={styles.deleteText}>Delete</Text>
            </Pressable>
          </View>
        )}
      />
      <View style={styles.footer}>
        <PrimaryButton label="Add contact" onPress={() => router.push("/(tabs)/contacts/choose")} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },
  notEntitledButton: {
    marginTop: spacing.lg,
    alignSelf: "stretch",
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
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    marginBottom: spacing.sm,
    backgroundColor: colors.card,
  },
  rowMain: {
    flex: 1,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  name: {
    ...typography.body,
    color: colors.text,
    fontWeight: "600",
  },
  number: {
    ...typography.caption,
    color: colors.textMuted,
  },
  deleteButton: {
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
  deleteText: {
    color: colors.danger,
    fontWeight: "600",
  },
  footer: {
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
});
