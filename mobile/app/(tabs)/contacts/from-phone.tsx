// "Add from my phone contacts" (Priority 4 fix). Uses Expo's native
// single-contact picker (Contacts.presentContactPickerAsync) rather than
// listing the device's address book ourselves: on iOS this requires no
// Contacts permission at all (the system picker runs out-of-process and
// only ever hands back the one contact the user explicitly taps), and on
// Android it's the standard Intent-based picker gated by READ_CONTACTS.
// Either way, this app never calls the bulk-listing API
// (Contacts.getContactsAsync) and never sees any contact the customer
// didn't explicitly pick — "select one or more" is implemented as
// repeated single picks, accumulated locally, not a bulk import.
import { useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import * as Contacts from "expo-contacts";
import { Platform } from "react-native";
import { Screen } from "../../../components/Screen";
import { PrimaryButton } from "../../../components/PrimaryButton";
import { Banner } from "../../../components/Banner";
import { addContact, ApiError } from "../../../lib/api";
import { addPickedContact, removePickedContact, usableNumbers, type PickedContact } from "../../../lib/contactSelection";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../../lib/theme";

function contactDisplayName(contact: Contacts.Contact): string {
  if (contact.name && contact.name.trim()) return contact.name.trim();
  const parts = [contact.firstName, contact.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "Unnamed contact";
}

export default function AddFromPhoneContacts() {
  const [selected, setSelected] = useState<PickedContact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  async function pickOne() {
    setError(null);

    // Point-of-use permission request — never at app launch, never before
    // the customer has actually chosen this path. On iOS this resolves
    // immediately without prompting (the picker itself doesn't require
    // Contacts permission); on Android it shows the standard system
    // dialog the first time.
    if (Platform.OS === "android") {
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== "granted") {
        setError("Home Call Guard needs permission to open your contacts. You can still add a contact manually.");
        return;
      }
    }

    let picked: Contacts.Contact | null;
    try {
      picked = await Contacts.presentContactPickerAsync();
    } catch {
      setError("We couldn't open your contacts. Please try again, or enter the contact manually.");
      return;
    }

    if (!picked) return; // user cancelled the picker — not an error

    const numbers = usableNumbers(picked.phoneNumbers);
    if (numbers.length === 0) {
      Alert.alert("No phone number", `${contactDisplayName(picked)} doesn't have a phone number saved.`);
      return;
    }

    const name = contactDisplayName(picked);

    if (numbers.length === 1) {
      addToSelection(name, numbers[0].number!);
      return;
    }

    // Multiple numbers on this contact — ask which one, rather than
    // guessing. Handles requirement: contacts with multiple phone numbers.
    Alert.alert(
      "Which number?",
      `${name} has more than one phone number saved.`,
      [
        ...numbers.map(p => ({
          text: `${p.label ? `${p.label}: ` : ""}${p.number}`,
          onPress: () => addToSelection(name, p.number!),
        })),
        { text: "Cancel", style: "cancel" as const },
      ]
    );
  }

  function addToSelection(name: string, number: string) {
    setSelected(prev => addPickedContact(prev, name, number));
  }

  function removeFromSelection(key: string) {
    setSelected(prev => removePickedContact(prev, key));
  }

  async function handleSaveAll() {
    setError(null);
    setIsSaving(true);

    const failures: string[] = [];
    for (const contact of selected) {
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

    if (failures.length === selected.length) {
      setError(`Nothing was saved:\n${failures.join("\n")}`);
      return;
    }

    // Partial success: don't hide the failures, but also don't discard the
    // contacts that genuinely saved — matches this app's existing "never
    // silently fail, never silently succeed" pattern.
    setSelected(prev => prev.filter(c => failures.some(f => f.startsWith(c.name))));
    setError(`Some contacts couldn't be saved:\n${failures.join("\n")}`);
  }

  return (
    <Screen scroll={false}>
      <View style={styles.container}>
        <Text style={styles.title}>Add from your contacts</Text>
        <Text style={styles.subtitle}>
          Choose contacts one at a time below. Home Call Guard only sees the ones you pick — never your full
          address book.
        </Text>

        {error && <Banner variant="error" message={error} />}

        <View style={styles.list}>
          {selected.length === 0 ? (
            <Text style={styles.emptyText}>No contacts chosen yet.</Text>
          ) : (
            selected.map(contact => (
              <View key={contact.key} style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={styles.rowName}>{contact.name}</Text>
                  <Text style={styles.rowNumber}>{contact.number}</Text>
                </View>
                <Pressable
                  onPress={() => removeFromSelection(contact.key)}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${contact.name}`}
                  style={styles.removeButton}
                >
                  <Text style={styles.removeText}>Remove</Text>
                </Pressable>
              </View>
            ))
          )}
        </View>

        <Pressable onPress={pickOne} style={({ pressed }) => [styles.pickButton, pressed && styles.pickButtonPressed]}>
          <Text style={styles.pickButtonText}>{selected.length === 0 ? "Choose a contact" : "Choose another contact"}</Text>
        </Pressable>

        <View style={styles.footer}>
          {isSaving ? (
            <ActivityIndicator color={colors.accent} size="large" />
          ) : (
            <PrimaryButton
              label={selected.length === 0 ? "Save" : `Save ${selected.length} contact${selected.length === 1 ? "" : "s"}`}
              onPress={handleSaveAll}
              disabled={selected.length === 0}
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
    padding: spacing.lg,
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
  removeButton: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: "center",
    paddingLeft: spacing.md,
  },
  removeText: {
    color: colors.danger,
    fontWeight: "600",
  },
  pickButton: {
    minHeight: MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 12,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  pickButtonPressed: {
    backgroundColor: colors.accentMuted,
  },
  pickButtonText: {
    color: colors.accent,
    fontWeight: "600",
    fontSize: 16,
  },
  footer: {
    paddingTop: spacing.sm,
  },
});
