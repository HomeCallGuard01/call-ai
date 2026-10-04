// D3 — Support. Per APP_VISUAL_SPECIFICATION.md: a single, obvious
// route to a real human, no chatbot. Only support@homecallguard.co.uk
// is used here — it's the one real, established support channel found
// across the existing product (public/terms.html, privacy.html,
// upload.html); no phone number exists anywhere in this codebase, so
// none is fabricated here. FAQ copy is reused verbatim from upload.html's
// existing "Common questions" section rather than invented fresh.
// Accordion rows per the revised UX_REVIEW_PERSONAS.md guidance — kept
// (a standard, expected pattern), with the whole row tappable rather
// than a small chevron.
import { useCallback, useState } from "react";
import { Text, View, Pressable, Linking, StyleSheet, Platform } from "react-native";
import { contactsPermissionHelp } from "../../../lib/iphoneAvailability";
import { router, useFocusEffect } from "expo-router";
import { fetchDashboard } from "../../../lib/api";
import { useAuth } from "../../../lib/AuthContext";
import { displayAccountNumber } from "../../../lib/protectionView";
import { Screen } from "../../../components/Screen";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../../lib/theme";

const SUPPORT_EMAIL = "support@homecallguard.co.uk";

const FAQ_ITEMS = [
  {
    question: "What happens when someone I don't know calls?",
    answer:
      "The call is put through to you, and Home Call Guard monitors it while you talk. If it detects clear signs of a scam, the call is ended automatically. You can see how each call was handled in Activity.",
  },
  {
    question: "Will calls from my family and friends be affected?",
    answer: "No. Anyone in your trusted contacts is put straight through, every time, and their calls are never monitored.",
  },
  {
    question: "How do I let Home Call Guard access my contacts?",
    answer:
      contactsPermissionHelp(Platform.OS),
  },
  {
    question: "Is my phone number changing?",
    answer: "No — you keep your existing number. Call forwarding sends your calls to Home Call Guard, and approved calls are put through to you.",
  },
  {
    question: "Does Home Call Guard work on a landline?",
    // Landline positioning (2026-09-24): matches the website's own
    // restrained wording exactly — no availability-date claim, no
    // timeline, no promise about landline support.
    answer: "Home Call Guard currently protects compatible mobile phones. We're exploring landline protection for the future.",
  },
  {
    question: "What is my HCG account number?",
    answer:
      "It's your permanent Home Call Guard reference, shown at the top of this page and on the Membership tab. Quote it whenever you contact us so we can find your account straight away. It never changes.",
  },
  {
    question: "What does \"Protection needs attention\" mean?",
    answer:
      "Something is stopping protected calls reaching you — for example, this phone isn't connected, or call forwarding needs updating. Your Home screen shows the one thing to do next. If it doesn't clear, contact us.",
  },
  {
    question: "What if I need help?",
    answer: `Contact us any time at ${SUPPORT_EMAIL} and we'll be glad to help. If you're calling on behalf of a family member, that's no problem — just let us know.`,
  },
];

export default function Support() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const { session } = useAuth();
  // 1.0.2: the permanent HCG account number (migration 062) is the support
  // identity. Shown and pre-filled into the email subject when known; the
  // screen works exactly as before when it isn't (older backend, no
  // membership, offline).
  const [accountNumber, setAccountNumber] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      fetchDashboard(session?.access_token)
        .then(d => setAccountNumber(displayAccountNumber(d.account?.accountNumber)))
        .catch(() => {});
    }, [session?.access_token])
  );
  const mailto = accountNumber
    ? `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Help with ${accountNumber}`)}`
    : `mailto:${SUPPORT_EMAIL}`;

  return (
    <Screen>
      {accountNumber && (
        <View style={styles.contactRow} accessible accessibilityLabel={`Your HCG account: ${accountNumber.split("").join(" ")}`}>
          <Text style={styles.contactLabel}>Your HCG account</Text>
          <Text style={styles.accountValue} selectable>{accountNumber}</Text>
        </View>
      )}

      <Pressable
        style={styles.contactRow}
        onPress={() => router.push("/(tabs)/account/set-up-call-forwarding")}
        accessibilityRole="button"
      >
        <Text style={styles.contactLabel}>Help</Text>
        <Text style={styles.contactValue}>Set up call forwarding</Text>
      </Pressable>

      <Pressable
        style={styles.contactRow}
        onPress={() => Linking.openURL(mailto)}
        accessibilityRole="button"
      >
        <Text style={styles.contactLabel}>Email support</Text>
        <Text style={styles.contactValue}>{SUPPORT_EMAIL}</Text>
      </Pressable>

      <Text style={styles.sectionTitle}>Common questions</Text>
      {FAQ_ITEMS.map((item, index) => {
        const isOpen = openIndex === index;
        return (
          <Pressable
            key={item.question}
            style={styles.faqRow}
            onPress={() => setOpenIndex(isOpen ? null : index)}
            accessibilityRole="button"
          >
            <View style={styles.faqHeader}>
              <Text style={styles.faqQuestion}>{item.question}</Text>
              <Text style={styles.faqToggle}>{isOpen ? "–" : "+"}</Text>
            </View>
            {isOpen && <Text style={styles.faqAnswer}>{item.answer}</Text>}
          </Pressable>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  contactRow: {
    minHeight: MIN_TOUCH_TARGET * 1.2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.card,
    padding: spacing.md,
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  contactLabel: {
    ...typography.caption,
    color: colors.textMuted,
  },
  accountValue: {
    ...typography.title,
    color: colors.text,
    letterSpacing: 1,
  },
  contactValue: {
    ...typography.body,
    color: colors.accent,
    fontWeight: "600",
  },
  sectionTitle: {
    ...typography.title,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  faqRow: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.card,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  faqHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    minHeight: MIN_TOUCH_TARGET - spacing.md * 2,
  },
  faqQuestion: {
    ...typography.body,
    color: colors.text,
    flex: 1,
    marginRight: spacing.sm,
  },
  faqToggle: {
    color: colors.accent,
    fontSize: 20,
    fontWeight: "700",
  },
  faqAnswer: {
    ...typography.body,
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
});
