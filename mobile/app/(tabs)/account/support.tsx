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
import { useState } from "react";
import { Text, View, Pressable, Linking, StyleSheet } from "react-native";
import { router } from "expo-router";
import { Screen } from "../../../components/Screen";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../../lib/theme";

const SUPPORT_EMAIL = "support@homecallguard.co.uk";

const FAQ_ITEMS = [
  {
    question: "What happens when someone I don't know calls?",
    answer:
      "We briefly ask them the reason for their call and check it before letting it through — this only takes a few seconds. If it looks like a scam, the call is stopped before it reaches you.",
  },
  {
    question: "Will calls from my family and friends be affected?",
    answer: "No. Anyone in your trusted contacts is put straight through, every time, with no checks or delays.",
  },
  {
    question: "How do I let Home Call Guard access my contacts?",
    answer:
      "When you tap Sync contacts, your phone will ask for permission. Choosing Full Access makes syncing easiest, both now and every time you sync again in future. If you'd rather share only some contacts, that's fine too — on iPhone this is called Limited Access, and you can add more at any time by tapping \"Add more contacts\" on the sync screen, or later via Settings > Home Call Guard > Contacts > Edit Selected Contacts. On Android, go to Settings > Apps > Home Call Guard > Permissions > Contacts to change access. Whichever you choose, Home Call Guard only ever stores the name and phone number needed to recognise a trusted caller — never any other information from your address book.",
  },
  {
    question: "Is my phone number changing?",
    answer: "No — you keep your existing number. We simply check your calls for you before they reach you.",
  },
  {
    question: "What if I need help?",
    answer: `Contact us any time at ${SUPPORT_EMAIL} and we'll be glad to help. If you're calling on behalf of a family member, that's no problem — just let us know.`,
  },
];

export default function Support() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <Screen>
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
        onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}
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
