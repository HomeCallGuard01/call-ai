// Home-screen warning when this phone cannot take protected calls properly
// (2026-09-30, release readiness; iOS microphone step added for iOS parity).
// Re-checks on mount and every time the app returns to the foreground, so it
// clears itself as soon as the customer fixes the permission.
//
//  - Android: microphone/notifications off → calls can't ring → Open Settings.
//  - iOS, microphone never asked → neutral explainer + "Continue", which
//    shows the system prompt (App Review 5.1.1(iv): the button always leads
//    to the prompt, no alternative wording that discourages or skips it).
//  - iOS, microphone denied → Open Settings.
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, Platform, View, StyleSheet } from "react-native";
import { Banner } from "./Banner";
import { PrimaryButton } from "./PrimaryButton";
import { getCallReadiness } from "../lib/callReadiness";
import { IOS_MICROPHONE_EXPLAINER, readinessMessage, readinessProblem, type ReadinessProblem } from "../lib/callReadinessModel";
import { getIosMicrophoneStatus, requestIosMicrophonePermission } from "../lib/microphonePermission";
import { spacing } from "../lib/theme";

export function CallReadinessBanner() {
  const [problem, setProblem] = useState<ReadinessProblem>(null);
  const [iosMicUndetermined, setIosMicUndetermined] = useState(false);

  const refresh = useCallback(() => {
    getCallReadiness()
      .then(r => setProblem(readinessProblem(r)))
      .catch(() => {});
    if (Platform.OS === "ios") {
      getIosMicrophoneStatus()
        .then(status => setIosMicUndetermined(status === "undetermined"))
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    let active = true;
    const guardedRefresh = () => { if (active) refresh(); };
    guardedRefresh();
    const sub = AppState.addEventListener("change", state => {
      if (state === "active") guardedRefresh();
    });
    return () => {
      active = false;
      sub.remove();
    };
  }, [refresh]);

  if (iosMicUndetermined) {
    return (
      <View style={styles.wrap}>
        <Banner variant="notice" message={IOS_MICROPHONE_EXPLAINER} />
        <PrimaryButton
          label="Continue"
          onPress={() => { requestIosMicrophonePermission().then(refresh).catch(() => {}); }}
        />
      </View>
    );
  }

  const message = readinessMessage(problem, Platform.OS === "ios" ? "ios" : "android");
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
