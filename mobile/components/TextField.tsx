import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, type TextInputProps } from "react-native";
import { colors, spacing, MIN_TOUCH_TARGET } from "../lib/theme";

interface Props extends TextInputProps {
  label: string;
  isPassword?: boolean;
  error?: string;
}

// Masked-by-default with an explicit show/hide toggle, per the revised
// UX_REVIEW_PERSONAS.md guidance — this is the correct universal
// pattern (not defaulting to visible text), matching the existing web
// register/login forms exactly.
export function TextField({ label, isPassword, error, style, ...inputProps }: Props) {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.inputRow}>
        <TextInput
          style={[styles.input, style]}
          placeholderTextColor={colors.textMuted}
          secureTextEntry={isPassword && !isVisible}
          autoCapitalize="none"
          autoCorrect={false}
          {...inputProps}
        />
        {isPassword && (
          <Pressable
            onPress={() => setIsVisible(v => !v)}
            style={styles.toggle}
            accessibilityLabel={isVisible ? "Hide password" : "Show password"}
            accessibilityRole="button"
          >
            <Text style={styles.toggleText}>{isVisible ? "Hide" : "Show"}</Text>
          </Pressable>
        )}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.md,
  },
  label: {
    color: colors.textMuted,
    fontSize: 14,
    marginBottom: spacing.xs,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.card,
  },
  input: {
    flex: 1,
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.md,
    color: colors.text,
    fontSize: 16,
  },
  toggle: {
    paddingHorizontal: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: "center",
  },
  toggleText: {
    color: colors.accent,
    fontWeight: "600",
  },
  error: {
    color: colors.danger,
    marginTop: spacing.xs,
    fontSize: 13,
  },
});
