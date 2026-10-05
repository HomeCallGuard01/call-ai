// In-app call screen (DT-1, real-device finding 2026-10-05).
//
// On an UNLOCKED iPhone, a CallKit call answered on the banner hands the screen
// to the calling app, which is expected to show its own in-call controls.
// HCG had none, so the customer lost the obvious way to hang up (Build 16,
// Motorola → …1883 → iPhone, ended from the caller's phone). This screen is
// shown over every route whenever a call is active: one big labelled End call
// button, plus Mute and Speaker. It never handles ringing or answering — that
// stays with CallKit (iOS) / the SDK notification (Android).
//
// Mounted once in app/_layout.tsx. State comes from lib/voiceClient.ts
// (subscribeActiveCall), logic from lib/activeCallModel.ts (pure, tested).
import { useEffect, useState } from "react";
import { Modal, View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, spacing, typography, radius, MIN_TOUCH_TARGET } from "../lib/theme";
import { IDLE_CALL, CALL_SCREEN_COPY, displayCaller, shouldShowCallScreen, statusLabel, type ActiveCallState } from "../lib/activeCallModel";
import { subscribeActiveCall, endActiveCall, setActiveCallMuted, setActiveCallSpeaker } from "../lib/voiceClient";

// Universal "hang up" red — deliberately not the app's amber warning colour.
const END_RED = "#e5484d";

export function ActiveCallScreen() {
  const [call, setCall] = useState<ActiveCallState>(IDLE_CALL);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => subscribeActiveCall(setCall), []);

  useEffect(() => {
    if (call.status !== "connected") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [call.status]);

  const visible = shouldShowCallScreen(call);
  const ending = call.status === "ending";
  const errorText =
    call.error === "end_failed" ? CALL_SCREEN_COPY.endFailed
    : call.error === "mute_failed" ? CALL_SCREEN_COPY.muteFailed
    : call.error === "speaker_failed" ? CALL_SCREEN_COPY.speakerFailed
    : null;

  return (
    <Modal visible={visible} animationType="fade" presentationStyle="fullScreen" onRequestClose={() => {}} statusBarTranslucent>
      <SafeAreaView style={styles.container}>
        <View style={styles.top}>
          <Text style={styles.eyebrow} accessibilityRole="header">{CALL_SCREEN_COPY.title.toUpperCase()}</Text>
          <Text style={styles.caller} accessibilityLabel={`Call with ${displayCaller(call.from)}`}>{displayCaller(call.from)}</Text>
          <Text style={styles.status} accessibilityLiveRegion="polite">{statusLabel(call, now)}</Text>
          {errorText ? <Text style={styles.error} accessibilityRole="alert">{errorText}</Text> : null}
        </View>

        <View style={styles.controls}>
          <ToggleButton
            icon={call.muted ? "mic-off" : "mic"}
            label={call.muted ? CALL_SCREEN_COPY.unmute : CALL_SCREEN_COPY.mute}
            active={call.muted}
            disabled={ending}
            onPress={() => setActiveCallMuted(!call.muted)}
          />
          <ToggleButton
            icon={call.speaker ? "volume-high" : "volume-medium"}
            label={call.speaker ? CALL_SCREEN_COPY.speakerOff : CALL_SCREEN_COPY.speakerOn}
            active={call.speaker}
            disabled={ending}
            onPress={() => setActiveCallSpeaker(!call.speaker)}
          />
        </View>

        <Pressable
          onPress={() => endActiveCall()}
          disabled={ending}
          style={({ pressed }) => [styles.endButton, (pressed || ending) && styles.endPressed]}
          accessibilityRole="button"
          accessibilityLabel={CALL_SCREEN_COPY.end}
          accessibilityHint="Hangs up this call"
        >
          <Ionicons name="call" size={30} color={colors.white} style={styles.endIcon} />
          <Text style={styles.endLabel}>{CALL_SCREEN_COPY.end}</Text>
        </Pressable>
      </SafeAreaView>
    </Modal>
  );
}

function ToggleButton({ icon, label, active, disabled, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; active: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.toggle, active && styles.toggleActive, (pressed || disabled) && styles.togglePressed]}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={30} color={active ? colors.onAccent : colors.text} />
      <Text style={[styles.toggleLabel, active && styles.toggleLabelActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.lg, justifyContent: "space-between" },
  top: { alignItems: "center", marginTop: spacing.xxl },
  eyebrow: { ...typography.eyebrow, color: colors.accent, marginBottom: spacing.md },
  caller: { ...typography.giant, color: colors.text, textAlign: "center" },
  status: { ...typography.title, color: colors.textMuted, marginTop: spacing.sm },
  error: { ...typography.body, color: colors.dangerText, textAlign: "center", marginTop: spacing.lg },
  controls: { flexDirection: "row", justifyContent: "center", gap: spacing.lg },
  toggle: {
    width: 120, minHeight: 110, borderRadius: radius.lg, backgroundColor: colors.cardElevated,
    borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center", gap: spacing.sm,
  },
  toggleActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  togglePressed: { opacity: 0.7 },
  toggleLabel: { ...typography.body, fontWeight: "600", color: colors.text },
  toggleLabelActive: { color: colors.onAccent },
  endButton: {
    minHeight: Math.max(MIN_TOUCH_TARGET, 76), borderRadius: radius.pill, backgroundColor: END_RED,
    flexDirection: "row", alignItems: "center", justifyContent: "center", marginBottom: spacing.xxl, gap: spacing.md,
  },
  endPressed: { opacity: 0.75 },
  endIcon: { transform: [{ rotate: "135deg" }] },
  endLabel: { fontSize: 22, fontWeight: "700", color: colors.white },
});
