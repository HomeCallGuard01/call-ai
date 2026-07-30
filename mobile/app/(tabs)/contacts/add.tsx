// C3 — Add/edit contact (manual entry). Per APP_VISUAL_SPECIFICATION.md:
// kept deliberately simple — this is the primary path for V1 (native
// contact-picker deferred), not a secondary fallback as the original
// spec assumed. Reuses the exact same backend validation/duplicate
// handling as the existing web /contacts routes (routes/mobileApi.js's
// POST/PUT /api/v1/contacts).
import { useState } from "react";
import { Text, StyleSheet } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Screen } from "../../../components/Screen";
import { TextField } from "../../../components/TextField";
import { PrimaryButton } from "../../../components/PrimaryButton";
import { Banner } from "../../../components/Banner";
import { addContact, updateContact, ApiError } from "../../../lib/api";
import { colors, spacing, typography } from "../../../lib/theme";

export default function AddOrEditContact() {
  const params = useLocalSearchParams<{ id?: string; name?: string; number?: string }>();
  const isEditing = !!params.id;

  const [name, setName] = useState(params.name || "");
  const [number, setNumber] = useState(params.number || "");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSave() {
    setError(null);

    if (!name.trim() || !number.trim()) {
      setError("Please enter both a name and a phone number.");
      return;
    }

    setIsSubmitting(true);
    try {
      if (isEditing) {
        await updateContact(params.id!, name.trim(), number.trim());
      } else {
        await addContact(name.trim(), number.trim());
      }
      router.back();
    } catch (err) {
      if (err instanceof ApiError && err.code === "duplicate") {
        setError(err.message || "This number is already in your trusted contacts.");
      } else if (err instanceof ApiError && err.code === "invalid_input") {
        setError("Please enter a valid UK phone number.");
      } else {
        setError("We couldn't save this contact. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Screen>
      <Text style={styles.title}>{isEditing ? "Edit contact" : "Add a trusted contact"}</Text>

      {error && <Banner variant="error" message={error} />}

      <TextField label="Name" value={name} onChangeText={setName} textContentType="name" />
      <TextField
        label="Phone number"
        value={number}
        onChangeText={setNumber}
        keyboardType="phone-pad"
        textContentType="telephoneNumber"
      />

      <PrimaryButton label="Save" onPress={handleSave} loading={isSubmitting} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: {
    ...typography.hero,
    color: colors.text,
    marginBottom: spacing.md,
  },
});
