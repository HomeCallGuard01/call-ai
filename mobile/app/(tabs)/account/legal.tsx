// D4 — Legal. Links to the existing, already-maintained terms.html/
// privacy.html on the web app — no content duplicated here.
import { Text, Pressable, StyleSheet } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { Screen } from "../../../components/Screen";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../../lib/theme";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

export default function Legal() {
  return (
    <Screen>
      <Pressable
        style={styles.row}
        onPress={() => WebBrowser.openBrowserAsync(`${API_BASE_URL}/terms.html`)}
        accessibilityRole="button"
      >
        <Text style={styles.rowText}>Terms and Conditions</Text>
      </Pressable>
      <Pressable
        style={styles.row}
        onPress={() => WebBrowser.openBrowserAsync(`${API_BASE_URL}/privacy.html`)}
        accessibilityRole="button"
      >
        <Text style={styles.rowText}>Privacy Policy</Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: MIN_TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.card,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  rowText: {
    ...typography.body,
    color: colors.text,
  },
});
