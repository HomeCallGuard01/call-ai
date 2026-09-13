// A1 — Splash. Auto-advances based on session state, per
// APP_VISUAL_SPECIFICATION.md: no session -> A2 (Welcome carousel),
// valid session -> straight into the app (the (tabs) group handles
// deciding Home vs a setup-incomplete prompt itself, so this screen's
// only job is "authenticated or not").
import { View, StyleSheet, ActivityIndicator } from "react-native";
import { Redirect } from "expo-router";
import { useAuth } from "../lib/AuthContext";
import { colors } from "../lib/theme";

export default function Splash() {
  const { session, isLoading } = useAuth();

  if (isLoading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  if (session) {
    return <Redirect href="/(tabs)" />;
  }

  return <Redirect href="/(auth)/welcome" />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
});
