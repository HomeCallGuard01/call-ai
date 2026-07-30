// B9 — Setup complete. Per APP_VISUAL_SPECIFICATION.md: the emotional
// payoff of onboarding, deliberately unhurried. V1's copy accounts for
// contacts not being added yet (native picker deferred — see verify.tsx)
// by pointing at the Contacts tab rather than implying it already
// happened.
import { Text, StyleSheet } from "react-native";
import { router } from "expo-router";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { colors, spacing, typography } from "../../lib/theme";

export default function SetupComplete() {
  return (
    <Screen>
      <Text style={styles.title}>You're protected</Text>
      <Text style={styles.body}>
        Home Call Guard is now screening unknown callers. Add trusted contacts any time from the
        Contacts tab — family and friends on that list always ring straight through.
      </Text>
      <PrimaryButton label="Go to my dashboard" onPress={() => router.replace("/(tabs)")} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: {
    ...typography.hero,
    color: colors.text,
    marginBottom: spacing.md,
  },
  body: {
    ...typography.body,
    color: colors.text,
    marginBottom: spacing.lg,
  },
});
