// D4 — Legal. Links to the existing, already-maintained terms.html/
// privacy.html on the web app — no content duplicated here.
//
// 2026-10-10 (WS4, Android Option C — Google Play Payments policy): Android
// opens the navigation-free copies, public/legal/terms-app.html and
// privacy-app.html. They are generated from terms.html/privacy.html (same
// legal text; tests/app-legal-pages.test.mjs fails if they drift) but have
// no site header or footer, so nothing in them leads on to the homepage,
// sign-up or web checkout ("may link ... as long as the web page does not
// eventually lead to" another payment method). iOS is unchanged.
import { Text, Pressable, StyleSheet, Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { Screen } from "../../../components/Screen";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../../lib/theme";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;
const TERMS_PATH = Platform.OS === "ios" ? "/terms.html" : "/legal/terms-app.html";
const PRIVACY_PATH = Platform.OS === "ios" ? "/privacy.html" : "/legal/privacy-app.html";

export default function Legal() {
  return (
    <Screen>
      <Pressable
        style={styles.row}
        onPress={() => WebBrowser.openBrowserAsync(`${API_BASE_URL}${TERMS_PATH}`)}
        accessibilityRole="button"
      >
        <Text style={styles.rowText}>Terms and Conditions</Text>
      </Pressable>
      <Pressable
        style={styles.row}
        onPress={() => WebBrowser.openBrowserAsync(`${API_BASE_URL}${PRIVACY_PATH}`)}
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
