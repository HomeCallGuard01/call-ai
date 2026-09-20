// New first step for adding a trusted contact (Priority 4 fix). Previously
// "Add contact" opened manual entry directly with no other option; this
// choice screen lets the customer pick between syncing from their phone
// (mobile/app/(tabs)/contacts/from-phone.tsx — imports everyone the OS
// has authorised, in one request) or typing details in by hand.
import { View, Text, Pressable, StyleSheet } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "../../../components/Screen";
import { BackLink } from "../../../components/BackLink";
import { colors, radius, spacing, typography, MIN_TOUCH_TARGET } from "../../../lib/theme";

export default function ChooseContactMethod() {
  return (
    <Screen>
      <BackLink />
      <Text style={styles.title}>Add a trusted contact</Text>
      <Text style={styles.subtitle}>
        Trusted contacts are never screened — their calls always ring straight through.
      </Text>

      <Option
        icon="people"
        label="Sync contacts"
        description="Import everyone your phone allows Home Call Guard to see, saved as trusted contacts in one go. Safe to run again any time — nothing is ever duplicated."
        onPress={() => router.push("/(tabs)/contacts/from-phone")}
      />
      <Option
        icon="create-outline"
        label="Enter manually"
        description="Type in a name and phone number yourself."
        onPress={() => router.push("/(tabs)/contacts/add")}
      />
    </Screen>
  );
}

function Option({ icon, label, description, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; description: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
      accessibilityRole="button"
    >
      <View style={styles.optionBadge}>
        <Ionicons name={icon} size={22} color={colors.accent} accessibilityElementsHidden importantForAccessibility="no" />
      </View>
      <View style={styles.optionText}>
        <Text style={styles.optionLabel}>{label}</Text>
        <Text style={styles.optionDescription}>{description}</Text>
      </View>
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
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    marginBottom: spacing.md,
  },
  optionBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  optionText: {
    flex: 1,
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
