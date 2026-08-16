// New first step for adding a trusted contact (Priority 4 fix). Previously
// "Add contact" opened manual entry directly with no other option; this
// choice screen lets the customer pick between importing from their phone
// or typing details in by hand, and states plainly, up front, that Home
// Call Guard never copies the full address book — only whichever
// individual contacts they explicitly select on the next screen.
import { View, Text, Pressable, StyleSheet } from "react-native";
import { router } from "expo-router";
import { Screen } from "../../../components/Screen";
import { BackLink } from "../../../components/BackLink";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../../lib/theme";

export default function ChooseContactMethod() {
  return (
    <Screen>
      <BackLink />
      <Text style={styles.title}>Add a trusted contact</Text>
      <Text style={styles.subtitle}>
        Trusted contacts are never screened — their calls always ring straight through.
      </Text>

      <Option
        label="Add from my phone contacts"
        description="See your contacts, tick everyone you want, then save them all at once. Home Call Guard only ever sees the contacts you tick — never your full address book."
        onPress={() => router.push("/(tabs)/contacts/from-phone")}
      />
      <Option
        label="Enter manually"
        description="Type in a name and phone number yourself."
        onPress={() => router.push("/(tabs)/contacts/add")}
      />
    </Screen>
  );
}

function Option({ label, description, onPress }: { label: string; description: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
      accessibilityRole="button"
    >
      <Text style={styles.optionLabel}>{label}</Text>
      <Text style={styles.optionDescription}>{description}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
  option: {
    minHeight: MIN_TOUCH_TARGET,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.card,
    marginBottom: spacing.md,
  },
  optionPressed: {
    borderColor: colors.accent,
  },
  optionLabel: {
    ...typography.body,
    color: colors.text,
    fontWeight: "600",
    marginBottom: spacing.xs,
  },
  optionDescription: {
    ...typography.caption,
    color: colors.textMuted,
  },
});
