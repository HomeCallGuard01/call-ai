// "Add from my phone contacts" — multi-select rewrite (2026-08-08).
//
// The previous version used Contacts.presentContactPickerAsync(), Expo's
// single-contact native picker, repeated once per person — real, but
// required reopening the system picker for every single contact, which a
// real customer test found too slow/repetitive for adding several
// trusted people at once.
//
// This version instead: requests full contacts permission
// (Contacts.requestPermissionsAsync()), reads the device address book
// once (Contacts.getContactsAsync()), and renders our own in-app,
// on-device checklist (mobile/lib/contactSelection.ts's
// buildSelectableContacts/toggleContactSelection) so the customer can
// tick several people in one screen before saving.
//
// Privacy, concretely, not just as a claim: the fetched list is held only
// in this screen's local component state — it is never sent anywhere.
// Only the contacts the customer explicitly ticks are ever transmitted,
// via the exact same addContact() calls the manual-entry and (removed)
// single-pick flows already used. The explanatory copy below is shown
// BEFORE the OS permission prompt is ever triggered, matching what
// Apple's own permission-priming guidance recommends and what was
// explicitly required for this change.
//
// On iOS 18+, Contacts.requestPermissionsAsync() may itself offer the
// customer "Limited Access" (Apple's own contact-selection UI, outside
// this app's control) instead of full access — confirmed directly
// against the installed expo-contacts type definitions
// (ContactsPermissionResponse.accessPrivileges: 'all' | 'limited' |
// 'none'). Either way, Contacts.getContactsAsync() can only ever return
// what the OS actually granted — this app has no way to see more, on any
// iOS version.
import { useState } from "react";
import { View, Text, Pressable, StyleSheet, TextInput, FlatList, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import * as Contacts from "expo-contacts";
import { Screen } from "../../../components/Screen";
import { PrimaryButton } from "../../../components/PrimaryButton";
import { Banner } from "../../../components/Banner";
import { BackLink } from "../../../components/BackLink";
import { addContact, ApiError } from "../../../lib/api";
import { buildSelectableContacts, toggleContactSelection, type SelectableContact } from "../../../lib/contactSelection";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../../lib/theme";

type ScreenState = "intro" | "loading" | "denied" | "list";

export default function AddFromPhoneContacts() {
  const [screenState, setScreenState] = useState<ScreenState>("intro");
  const [contacts, setContacts] = useState<SelectableContact[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Point-of-use only — never requested at app launch, never before the
  // customer has both seen the explanation above and actively tapped to
  // continue.
  async function requestAccessAndLoad() {
    setError(null);
    setScreenState("loading");

    let permission: Contacts.ContactsPermissionResponse;
    try {
      permission = await Contacts.requestPermissionsAsync();
    } catch {
      setError("We couldn't open your contacts. Please try again, or enter the contact manually.");
      setScreenState("intro");
      return;
    }

    if (permission.status !== "granted") {
      setScreenState("denied");
      return;
    }

    try {
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers],
        sort: Contacts.SortTypes.FirstName,
      });
      setContacts(buildSelectableContacts(data));
      setScreenState("list");
    } catch {
      setError("We couldn't load your contacts just now. Please try again, or enter the contact manually.");
      setScreenState("intro");
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds(prev => toggleContactSelection(prev, id));
  }

  async function handleSaveSelected() {
    setError(null);
    setIsSaving(true);

    const toSave = contacts.filter(c => selectedIds.includes(c.id));
    const failures: string[] = [];

    for (const contact of toSave) {
      try {
        await addContact(contact.name, contact.number);
      } catch (err) {
        if (err instanceof ApiError && err.code === "duplicate") {
          failures.push(`${contact.name} — already in your trusted contacts`);
        } else if (err instanceof ApiError && err.code === "invalid_input") {
          failures.push(`${contact.name} — not a valid UK phone number`);
        } else {
          failures.push(`${contact.name} — couldn't be saved`);
        }
      }
    }

    setIsSaving(false);

    if (failures.length === 0) {
      router.back();
      router.back(); // also skip past the choice screen, back to the list
      return;
    }

    if (failures.length === toSave.length) {
      setError(`Nothing was saved:\n${failures.join("\n")}`);
      return;
    }

    // Partial success: leave the customer able to see and retry exactly
    // what didn't work, without losing their place in the list.
    setError(`Some contacts couldn't be saved:\n${failures.join("\n")}`);
  }

  const visibleContacts = query.trim()
    ? contacts.filter(c => c.name.toLowerCase().includes(query.trim().toLowerCase()))
    : contacts;

  if (screenState === "intro" || screenState === "loading") {
    return (
      <Screen scroll={false}>
        <View style={styles.container}>
          <BackLink />
          <Text style={styles.title}>Add from your contacts</Text>
          <Text style={styles.subtitle}>
            Home Call Guard will show your phone's contact list so you can pick several trusted people at once.
            Your contacts stay on this device — we only save the people you tick below, never your full address
            book.
          </Text>

          {error && <Banner variant="error" message={error} />}

          {screenState === "loading" ? (
            <ActivityIndicator color={colors.accent} size="large" style={styles.loadingSpinner} />
          ) : (
            <PrimaryButton label="Choose from my contacts" onPress={requestAccessAndLoad} />
          )}

          <Pressable
            onPress={() => router.replace("/(tabs)/contacts/add")}
            accessibilityRole="button"
            style={styles.manualLink}
          >
            <Text style={styles.manualLinkText}>Enter a contact manually instead</Text>
          </Pressable>
        </View>
      </Screen>
    );
  }

  if (screenState === "denied") {
    return (
      <Screen scroll={false}>
        <View style={styles.container}>
          <BackLink />
          <Text style={styles.title}>Add from your contacts</Text>
          <Banner
            variant="error"
            message="Home Call Guard needs permission to open your contacts. You can still add contacts manually."
          />
          <PrimaryButton label="Enter a contact manually" onPress={() => router.replace("/(tabs)/contacts/add")} />
        </View>
      </Screen>
    );
  }

  // screenState === "list"
  return (
    <Screen scroll={false}>
      <View style={styles.container}>
        <BackLink />
        <Text style={styles.title}>Choose your trusted contacts</Text>
        <Text style={styles.subtitle}>Tick everyone you'd like to add, then save them all at once.</Text>

        {error && <Banner variant="error" message={error} />}

        {contacts.length > 0 && (
          <TextInput
            style={styles.searchInput}
            placeholder="Search your contacts"
            placeholderTextColor={colors.textMuted}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
          />
        )}

        {contacts.length === 0 ? (
          <Text style={styles.emptyText}>No contacts with a phone number were found on this device.</Text>
        ) : (
          <FlatList
            data={visibleContacts}
            keyExtractor={item => item.id}
            style={styles.list}
            renderItem={({ item }) => {
              const isSelected = selectedIds.includes(item.id);
              return (
                <Pressable
                  onPress={() => toggleSelected(item.id)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSelected }}
                  accessibilityLabel={`${item.name}, ${item.number}`}
                  style={({ pressed }) => [styles.row, isSelected && styles.rowSelected, pressed && styles.rowPressed]}
                >
                  <View style={[styles.checkbox, isSelected && styles.checkboxChecked]}>
                    {isSelected && <Text style={styles.checkboxMark}>✓</Text>}
                  </View>
                  <View style={styles.rowText}>
                    <Text style={styles.rowName}>{item.name}</Text>
                    <Text style={styles.rowNumber}>{item.number}</Text>
                  </View>
                </Pressable>
              );
            }}
            ListEmptyComponent={<Text style={styles.emptyText}>No contacts match your search.</Text>}
          />
        )}

        <View style={styles.footer}>
          {isSaving ? (
            <ActivityIndicator color={colors.accent} size="large" />
          ) : (
            <PrimaryButton
              label={selectedIds.length === 0 ? "Save" : `Save ${selectedIds.length} contact${selectedIds.length === 1 ? "" : "s"}`}
              onPress={handleSaveSelected}
              disabled={selectedIds.length === 0}
            />
          )}
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  title: {
    ...typography.hero,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  subtitle: {
    ...typography.body,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  loadingSpinner: {
    marginTop: spacing.lg,
  },
  manualLink: {
    minHeight: MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.md,
  },
  manualLinkText: {
    color: colors.accent,
    fontWeight: "600",
  },
  searchInput: {
    minHeight: MIN_TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    color: colors.text,
    backgroundColor: colors.card,
    marginBottom: spacing.md,
  },
  list: {
    flexGrow: 1,
  },
  emptyText: {
    ...typography.body,
    color: colors.textMuted,
    paddingVertical: spacing.lg,
    textAlign: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.card,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
  },
  rowSelected: {
    borderColor: colors.accent,
  },
  rowPressed: {
    opacity: 0.85,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },
  checkboxChecked: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  checkboxMark: {
    color: colors.background,
    fontWeight: "700",
    fontSize: 14,
  },
  rowText: {
    flex: 1,
    paddingVertical: spacing.sm,
  },
  rowName: {
    ...typography.body,
    color: colors.text,
    fontWeight: "600",
  },
  rowNumber: {
    ...typography.caption,
    color: colors.textMuted,
  },
  footer: {
    paddingTop: spacing.sm,
  },
});
