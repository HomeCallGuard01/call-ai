// Home-screen warning when this phone cannot ring for protected calls
// (2026-09-30, release readiness). Re-checks on mount and every time the app
// returns to the foreground, so it clears itself as soon as the customer
// fixes the permission in Settings. Renders nothing when ready or unknown.
import { useEffect, useState } from "react";
import { AppState, Linking, View, StyleSheet } from "react-native";
import { Banner } from "./Banner";
import { PrimaryButton } from "./PrimaryButton";
import { getCallReadiness } from "../lib/callReadiness";
import { readinessMessage, readinessProblem, type ReadinessProblem } from "../lib/callReadinessModel";
import { spacing } from "../lib/theme";

export function CallReadinessBanner() {
  const [problem, setProblem] = useState<ReadinessProblem>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      getCallReadiness()
        .then(r => { if (!cancelled) setProblem(readinessProblem(r)); })
        .catch(() => {});
    };
    refresh();
    const sub = AppState.addEventListener("change", state => {
      if (state === "active") refresh();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  const message = readinessMessage(problem);
  if (!message) return null;
  return (
    <View style={styles.wrap} accessibilityLiveRegion="polite">
      <Banner variant="error" message={message} />
      <PrimaryButton label="Open Settings" onPress={() => { Linking.openSettings().catch(() => {}); }} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.md },
});
