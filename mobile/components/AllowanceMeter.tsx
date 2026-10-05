// Monthly call checking meter (customer allowance, 2026-10-03). One
// percentage, one bar, one reset date and — only when it matters — one
// plain sentence. Every figure comes from the server's customerAllowance
// (backend services/allowance/customerAllowance.js); nothing is calculated
// here, so the app can never show a usage figure the server doesn't hold.
//
// DRAFT customer wording — needs Andrew's approval before release (DT-2
// protection-allowance wording added 2026-10-05; decision I-3).
//
// No in-app top-up purchase yet: that needs a StoreKit consumable (iOS)
// and a Play Billing in-app product (Android), neither of which exists.
// The server already lists store top-ups when configured
// (customerAllowance.topUp); wiring a purchase button is a later build.
import { Text, View, StyleSheet } from "react-native";
import { Card, type Tone } from "./Card";
import { colors, radius, spacing, typography } from "../lib/theme";
import type { CustomerAllowance } from "../lib/types";

function formatResetDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "Europe/London" });
}

// DT-2 (real-device finding 2026-10-05): on the Fortress basis the meter is
// the household's monthly protection spend — EVERY handled call uses some of
// it, trusted calls included (two ~45 s trusted calls took 12% of a staging
// test budget). So that basis is called "protection allowance", never "call
// checking", and never says trusted calls don't use it. The 056 minutes basis
// (checking unknown calls only) keeps its original, true wording.
export function isSpendBasis(a: CustomerAllowance): boolean {
  return a.basis === "protection_spend" || a.trustedCallsUseAllowance === true;
}

export function allowanceTitle(a: CustomerAllowance): string {
  return isSpendBasis(a) ? "PROTECTION ALLOWANCE THIS MONTH" : "CALL CHECKING THIS MONTH";
}

export const SPEND_BASIS_EXPLAINER =
  "Every call Home Call Guard handles uses a little of this. Checking calls from unknown numbers uses the most.";

export function allowanceMessage(a: CustomerAllowance): string | null {
  const resets = formatResetDate(a.allowance.resetsAt);
  const until = resets ? ` until it resets on ${resets}` : " until it resets";
  const spend = isSpendBasis(a);
  switch (a.status) {
    case "low":
      return spend
        ? "You've used most of this month's protection allowance."
        : "You've used most of this month's call checking. Calls from people you trust don't use it.";
    case "very_low":
      return spend
        ? "You're nearly out of this month's protection allowance. Calls from unknown numbers use it fastest."
        : "You're nearly out of this month's call checking. Calls from people you trust don't use it.";
    case "used_up":
      if (spend) {
        return a.monitoringActive === false
          ? `This month's protection allowance is used up. Calls still reach you, but calls from unknown numbers won't be checked for scams${until}.`
          : "This month's protection allowance is used up. We're still checking calls from unknown numbers for now.";
      }
      return a.monitoringActive === false
        ? `You've used this month's call checking. Your phone still works normally and every call still reaches you, but calls from unknown numbers won't be checked for scams${until}.`
        : "You've used this month's included call checking. We're still checking calls from unknown numbers for now.";
    case "calls_limited":
      return a.trustedCallersContinue
        ? `You've used this month's protection allowance. Calls from people you trust still get through. Until it resets${resets ? ` on ${resets}` : ""}, other calls forwarded to Home Call Guard may not get through. Please contact support@homecallguard.co.uk if you need help.`
        : `You've used this month's protection allowance. Until it resets${resets ? ` on ${resets}` : ""}, calls forwarded to Home Call Guard may not get through. Please contact support@homecallguard.co.uk if you need help.`;
    case "paused":
      return spend
        ? "Scam checking is paused for a short while. Your phone still works normally and every call still reaches you."
        : "Call checking is paused for a short while. Your phone still works normally and every call still reaches you.";
    case "unavailable":
      return "We can't show your usage right now. Please check back shortly.";
    default:
      return null;
  }
}

const CARD_TONE: Record<CustomerAllowance["tone"], Tone> = { good: "default", caution: "warning", critical: "warning", neutral: "neutral" };

export function AllowanceMeter({ allowance }: { allowance?: CustomerAllowance }) {
  if (!allowance || allowance.version !== 1 || allowance.status === "inactive") return null;
  const remaining = allowance.allowance.remainingPercent;
  const known = typeof remaining === "number";
  const resets = formatResetDate(allowance.allowance.resetsAt);
  const message = allowanceMessage(allowance);
  const fillColour = allowance.tone === "good" ? colors.accent : allowance.tone === "neutral" ? colors.neutral : colors.danger;

  return (
    <Card tone={CARD_TONE[allowance.tone]} style={styles.card}>
      <Text style={styles.eyebrow}>{allowanceTitle(allowance)}</Text>
      <View style={styles.headline}>
        <Text style={[styles.percent, { color: fillColour }]}>{known ? `${remaining}%` : "—"}</Text>
        {known && <Text style={styles.percentLabel}>left</Text>}
      </View>
      <View
        style={styles.track}
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={isSpendBasis(allowance) ? "Protection allowance left this month" : "Call checking left this month"}
        accessibilityValue={{ min: 0, max: 100, now: known ? remaining : 0 }}
      >
        <View style={[styles.fill, { width: `${known ? Math.max(0, Math.min(100, remaining as number)) : 0}%`, backgroundColor: fillColour }]} />
      </View>
      {resets && <Text style={styles.reset}>Resets on {resets}</Text>}
      {isSpendBasis(allowance) && allowance.status === "ok" && <Text style={styles.reset}>{SPEND_BASIS_EXPLAINER}</Text>}
      {message && <Text style={styles.message}>{message}</Text>}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: spacing.md },
  eyebrow: { ...typography.eyebrow, color: colors.textMuted },
  headline: { flexDirection: "row", alignItems: "baseline", marginTop: spacing.sm, marginBottom: spacing.sm },
  percent: { ...typography.hero },
  percentLabel: { ...typography.body, color: colors.textMuted, marginLeft: spacing.sm },
  track: { height: 10, borderRadius: radius.pill, backgroundColor: colors.border, overflow: "hidden" },
  fill: { height: "100%", borderRadius: radius.pill },
  reset: { ...typography.caption, color: colors.textMuted, marginTop: spacing.sm },
  message: { ...typography.body, color: colors.text, marginTop: spacing.sm, lineHeight: 22 },
});
