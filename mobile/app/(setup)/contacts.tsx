// NEW — trusted contacts, moved into the guided setup flow ahead of
// activation (previously reachable only from the Contacts tab, entirely
// skippable, after setup was already "complete"). Per the approved
// launch model: protection should never go live with an empty trusted
// list, since that's the exact window a genuine family member could be
// screened as a stranger the moment call forwarding activates.
//
// Not a hard, unskippable wall, though — "Skip for now" remains
// available, explicitly explained rather than hidden, because trapping
// someone who genuinely can't add a contact right now inside an app
// they've just paid for would be a worse outcome than a gentle,
// persistent nudge later (see the Home dashboard's trusted-contacts
// banner). This is the same native single-contact-picker loop as the
// Contacts tab's own flow (Contacts.presentContactPickerAsync — no bulk
// address-book access ever granted), with manual entry folded into the
// same screen instead of a separate one, and framed for setup rather
// than tab-navigation context.
import { useState, useRef, useEffect, useCallback } from "react";
import { Text, View, Pressable, StyleSheet, Alert, ActivityIndicator, Platform } from "react-native";
import { router } from "expo-router";
import * as Contacts from "expo-contacts";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { TextField } from "../../components/TextField";
import { SetupProgress } from "../../components/SetupProgress";
import { addContact, ApiError } from "../../lib/api";
import {
  addPickedContact,
  removePickedContact,
  usableNumbers,
  looksLikePhoneNumber,
  contactsStillNeedingSave,
  describeSaveFailure,
  type PickedContact,
  type SaveResult,
} from "../../lib/contactSelection";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../lib/theme";

function contactDisplayName(contact: Contacts.Contact): string {
  if (contact.name && contact.name.trim()) return contact.name.trim();
  const parts = [contact.firstName, contact.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "Unnamed contact";
}

export default function SetupContacts() {
  const [selected, setSelected] = useState<PickedContact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualNumber, setManualNumber] = useState("");
  const [manualNumberError, setManualNumberError] = useState<string | null>(null);

  // presentContactPickerAsync/addContact are all async work that can
  // outlive this screen (back button, Skip, or a fast double-tap through
  // to the next step while a save is still in flight) — every setState
  // after an await checks this first so we never warn-or-leak by setting
  // state on an unmounted screen.
  const isMounted = useRef(true);
  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  const pickOne = useCallback(async () => {
    // presentContactPickerAsync() opens a native modal; without this
    // guard a fast double-tap (or a stuck first tap) could invoke it a
    // second time while the first is still awaiting, opening two
    // pickers/permission prompts stacked on each other.
    if (isPicking) return;
    setIsPicking(true);
    setError(null);

    try {
      if (Platform.OS === "android") {
        const { status } = await Contacts.requestPermissionsAsync();
        if (!isMounted.current) return;
        if (status !== "granted") {
          setError("Home Call Guard needs permission to open your contacts. You can still add someone manually below.");
          return;
        }
      }

      let picked: Contacts.Contact | null;
      try {
        picked = await Contacts.presentContactPickerAsync();
      } catch {
        if (isMounted.current) {
          setError("We couldn't open your contacts. Please try again, or add someone manually below.");
        }
        return;
      }
      if (!isMounted.current) return;

      if (!picked) return;

      const numbers = usableNumbers(picked.phoneNumbers);
      if (numbers.length === 0) {
        Alert.alert("No phone number", `${contactDisplayName(picked)} doesn't have a phone number saved.`);
        return;
      }

      const name = contactDisplayName(picked);

      if (numbers.length === 1) {
        setSelected(prev => addPickedContact(prev, name, numbers[0].number!));
        return;
      }

      Alert.alert(
        "Which number?",
        `${name} has more than one phone number saved.`,
        [
          ...numbers.map(p => ({
            text: `${p.label ? `${p.label}: ` : ""}${p.number}`,
            onPress: () => setSelected(prev => addPickedContact(prev, name, p.number!)),
          })),
          { text: "Cancel", style: "cancel" as const },
        ]
      );
    } finally {
      if (isMounted.current) setIsPicking(false);
    }
  }, [isPicking]);

  function addManual() {
    const name = manualName.trim();
    const number = manualNumber.trim();
    if (!name || !number) {
      setManualNumberError(null);
      setError("Please enter both a name and a phone number.");
      return;
    }
    // Catches an obviously malformed number (too short, letters) at the
    // moment of entry instead of only after a round trip to the server
    // when the customer taps Continue — see lib/contactSelection.ts's
    // looksLikePhoneNumber for why this doesn't replace server-side
    // validation, only front-loads the unambiguous case.
    if (!looksLikePhoneNumber(number)) {
      setError(null);
      setManualNumberError("That doesn't look like a full phone number.");
      return;
    }
    setError(null);
    setManualNumberError(null);
    setSelected(prev => addPickedContact(prev, name, number));
    setManualName("");
    setManualNumber("");
    setShowManual(false);
  }

  async function handleContinue() {
    setError(null);
    setIsSaving(true);

    // Saved in parallel rather than one round trip at a time — the
    // product advertises unlimited trusted contacts, and a sequential
    // loop would make adding, say, ten family members visibly slower
    // for no benefit (each save is independent, order never matters).
    const results: SaveResult[] = await Promise.all(
      selected.map(async (contact): Promise<SaveResult> => {
        try {
          await addContact(contact.name, contact.number);
          return { key: contact.key, name: contact.name, outcome: "saved" };
        } catch (err) {
          if (err instanceof ApiError && err.code === "duplicate") {
            // Already trusted server-side under a separate action — a
            // complete outcome, not a failure to retry.
            return { key: contact.key, name: contact.name, outcome: "duplicate" };
          }
          if (err instanceof ApiError && err.code === "invalid_input") {
            return { key: contact.key, name: contact.name, outcome: "invalid" };
          }
          return { key: contact.key, name: contact.name, outcome: "failed" };
        }
      })
    );

    if (!isMounted.current) return;
    setIsSaving(false);

    const stillNeedsSaveKeys = contactsStillNeedingSave(results);
    if (stillNeedsSaveKeys.length === 0) {
      router.push("/(setup)/device-picker");
      return;
    }
    if (stillNeedsSaveKeys.length === selected.length) {
      const messages = results.filter(r => stillNeedsSaveKeys.includes(r.key)).map(describeSaveFailure);
      setError(`Nothing was saved:\n${messages.join("\n")}`);
      return;
    }
    const stillNeedsSave = new Set(stillNeedsSaveKeys);
    const messages = results.filter(r => stillNeedsSave.has(r.key)).map(describeSaveFailure);
    setSelected(prev => prev.filter(c => stillNeedsSave.has(c.key)));
    setError(`Some contacts couldn't be saved:\n${messages.join("\n")}`);
  }

  function handleSkip() {
    Alert.alert(
      "Skip for now?",
      "You can add trusted contacts any time from the Contacts tab. Until you do, calls from family and friends may be screened the same as an unknown caller.",
      [
        { text: "Go back", style: "cancel" },
        { text: "Skip anyway", style: "destructive", onPress: () => router.push("/(setup)/device-picker") },
      ]
    );
  }

  return (
    <Screen scroll={false}>
      <View style={styles.container}>
        <SetupProgress currentStep={2} />

        <Text style={styles.title} accessibilityRole="header">Who should always get through?</Text>
        <Text style={styles.subtitle}>
          Add family and friends here — their calls will always ring straight through, never screened.
          We only ever see the specific people you choose, never your full address book.
        </Text>

        {error && <Banner variant="error" message={error} />}

        <View style={styles.list}>
          {selected.length === 0 ? (
            <Text style={styles.emptyText}>No trusted contacts added yet.</Text>
          ) : (
            selected.map(contact => (
              <View key={contact.key} style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={styles.rowName} numberOfLines={1}>{contact.name}</Text>
                  <Text style={styles.rowNumber} numberOfLines={1}>{contact.number}</Text>
                </View>
                <Pressable
                  onPress={() => setSelected(prev => removePickedContact(prev, contact.key))}
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

        {showManual ? (
          <View style={styles.manualForm}>
            <TextField label="Name" value={manualName} onChangeText={setManualName} textContentType="name" />
            <TextField
              label="Phone number"
              value={manualNumber}
              onChangeText={text => {
                setManualNumber(text);
                if (manualNumberError) setManualNumberError(null);
              }}
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
              error={manualNumberError ?? undefined}
            />
            <View style={styles.manualFormButtons}>
              <PrimaryButton
                label="Cancel"
                variant="secondary"
                onPress={() => {
                  setShowManual(false);
                  setManualNumberError(null);
                }}
              />
              <PrimaryButton label="Add" onPress={addManual} />
            </View>
          </View>
        ) : (
          <>
            <Pressable
              onPress={pickOne}
              disabled={isPicking}
              style={({ pressed }) => [styles.pickButton, (pressed || isPicking) && styles.pickButtonPressed]}
            >
              <Text style={styles.pickButtonText}>
                {isPicking ? "Opening…" : selected.length === 0 ? "Choose from Contacts" : "Choose another contact"}
              </Text>
            </Pressable>
            <Pressable onPress={() => setShowManual(true)} style={styles.manualLink} accessibilityRole="button">
              <Text style={styles.manualLinkText}>Enter details manually instead</Text>
            </Pressable>
          </>
        )}

        <View style={styles.footer}>
          {isSaving ? (
            <ActivityIndicator color={colors.accent} size="large" />
          ) : (
            <>
              <PrimaryButton
                label={selected.length === 0 ? "Continue" : `Continue with ${selected.length} contact${selected.length === 1 ? "" : "s"}`}
                onPress={handleContinue}
                disabled={selected.length === 0}
              />
              <Pressable onPress={handleSkip} style={styles.skipLink} accessibilityRole="button">
                <Text style={styles.skipLinkText}>Skip for now</Text>
              </Pressable>
            </>
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
  manualForm: {
    marginBottom: spacing.md,
  },
  manualFormButtons: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  pickButton: {
    minHeight: MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 12,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  pickButtonPressed: {
    backgroundColor: colors.accentMuted,
  },
  pickButtonText: {
    color: colors.accent,
    fontWeight: "600",
    fontSize: 16,
  },
  manualLink: {
    alignSelf: "center",
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  manualLinkText: {
    color: colors.textMuted,
    fontWeight: "600",
    textDecorationLine: "underline",
  },
  footer: {
    paddingTop: spacing.sm,
  },
  skipLink: {
    alignSelf: "center",
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
  skipLinkText: {
    color: colors.textMuted,
    fontSize: 14,
  },
});
