// Allowance state banner on Home (WS3, 2026-10-10).
//
// Shows the server's allowanceState (WS2) in plain words — screening running
// low, screening paused, calls may soon stop, ceiling reached — and, where it
// helps, the honest way back to normal mobile calling: "Turn off call
// forwarding", which opens the guided screen (Android: Phone app pre-filled,
// the customer presses Call; iPhone: code + Settings path). Nothing here
// claims forwarding switches itself off.
//
// Google Play (Option C, consumption-only Android app): no purchase button,
// link, price or QR. The only "more" wording is plain, non-tappable text on
// Android; iOS shows none. All copy lives in lib/allowanceState.ts (pure,
// tested in tests/mobile-allowance-state.test.mjs).
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { PrimaryButton } from "./PrimaryButton";
import { colors, radius, spacing, typography } from "../lib/theme";
import { TURN_OFF_FORWARDING_LABEL, type AllowanceBanner } from "../lib/allowanceState";

export const TURN_OFF_FORWARDING_ROUTE = "/(tabs)/account/turn-off-protection";

export function AllowanceStatusBanner({ banner }: { banner: AllowanceBanner | null }) {
  if (!banner) return null;
  const isNotice = banner.tone === "notice";
  return (
    <View style={[styles.card, isNotice ? styles.notice : styles.warning]} accessibilityRole={isNotice ? "summary" : "alert"}>
      <View style={styles.titleRow}>
        <Ionicons
          name={isNotice ? "information-circle" : "alert-circle"}
          size={20}
          color={isNotice ? colors.accent : colors.danger}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
        <Text style={[styles.title, isNotice ? styles.noticeText : styles.warningText]} accessibilityRole="header">
          {banner.title}
        </Text>
      </View>
      <Text style={[styles.body, isNotice ? styles.noticeText : styles.warningText]}>{banner.body}</Text>
      {banner.moreNote && <Text style={styles.note}>{banner.moreNote}</Text>}
      {banner.offerTurnOffForwarding && (
        <>
          {banner.turnOffExplainer && <Text style={styles.note}>{banner.turnOffExplainer}</Text>}
          <PrimaryButton
            label={TURN_OFF_FORWARDING_LABEL}
            variant="secondary"
            onPress={() => router.push(TURN_OFF_FORWARDING_ROUTE as any)}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.md, borderWidth: 1.5, padding: spacing.md, marginTop: spacing.md, marginBottom: spacing.md, gap: spacing.sm },
  notice: { backgroundColor: colors.accentMuted, borderColor: colors.accent },
  warning: { backgroundColor: colors.dangerBackground, borderColor: colors.danger },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  title: { ...typography.body, fontWeight: "700", flex: 1 },
  body: { fontSize: 15, lineHeight: 21 },
  note: { ...typography.caption, color: colors.textMuted, lineHeight: 19 },
  noticeText: { color: colors.noticeText },
  warningText: { color: colors.dangerText },
});
