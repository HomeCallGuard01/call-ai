// B3 — Device & provider picker. Per APP_VISUAL_SPECIFICATION.md: large
// tappable icon-cards (not a dropdown — a visual, one-glance choice
// reads as more premium and is faster to scan, regardless of who's
// using it), auto-advances on selection. Purely a local routing
// decision — no backend call needed, the choice only determines which
// copy B4 shows.
import { useState } from "react";
import { Text, View, Pressable, StyleSheet } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "../../components/Screen";
import { SetupProgress } from "../../components/SetupProgress";
import { TextField } from "../../components/TextField";
import { PrimaryButton } from "../../components/PrimaryButton";
import { looksLikePhoneNumber } from "../../lib/contactSelection";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../lib/theme";
import type { DeviceType, LandlineProvider } from "../../lib/types";

const DEVICE_OPTIONS: { type: DeviceType; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { type: "iphone", label: "iPhone", icon: "logo-apple" },
  { type: "android", label: "Android phone", icon: "logo-android" },
  { type: "landline", label: "Landline", icon: "call" },
];

const LANDLINE_PROVIDERS: { provider: LandlineProvider; label: string }[] = [
  { provider: "bt", label: "BT" },
  { provider: "sky", label: "Sky" },
  { provider: "virgin", label: "Virgin Media" },
  { provider: "talktalk", label: "TalkTalk" },
  { provider: "plusnet", label: "Plusnet" },
  { provider: "other", label: "Not sure / another provider" },
];

export default function DevicePicker() {
  const [deviceType, setDeviceType] = useState<DeviceType | null>(null);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [numberError, setNumberError] = useState<string | null>(null);

  function selectDevice(type: DeviceType) {
    setDeviceType(type);
  }

  function selectProvider(provider: LandlineProvider) {
    router.push({ pathname: "/(setup)/activate", params: { deviceType: "landline", provider } });
  }

  // Real iPhone testing (2026-08-08/09) found that forwarding this phone
  // to Home Call Guard and also setting it as the destination for safe
  // calls creates an inescapable loop — the phone can never ring again,
  // for anyone. Confirming the number here lets the backend check for
  // exactly that before showing an activation code (see
  // fetchActivationInstructions's protectedNumber and
  // services/phone.js's wouldCreateForwardingLoop). Only asked for
  // iPhone/Android, where this device's own line is what's being
  // forwarded — a landline is always a physically separate line, so this
  // specific risk doesn't apply there.
  function confirmMobileNumber() {
    const trimmed = phoneNumber.trim();
    if (!looksLikePhoneNumber(trimmed)) {
      setNumberError("Please enter a full UK phone number.");
      return;
    }
    setNumberError(null);
    router.push({
      pathname: "/(setup)/activate",
      params: { deviceType: deviceType!, protectedNumber: trimmed },
    });
  }

  if (deviceType === "iphone" || deviceType === "android") {
    return (
      <Screen>
        <SetupProgress currentStep={3} />
        <Pressable onPress={() => setDeviceType(null)} accessibilityRole="button" style={styles.backLink}>
          <Text style={styles.backLinkText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">What's this phone's number?</Text>
        <Text style={styles.subtitle}>
          The number of the {deviceType === "iphone" ? "iPhone" : "Android phone"} you're about to forward to
          Home Call Guard — we check it isn't the same number safe calls would be sent back to.
        </Text>
        <TextField
          label="Phone number"
          value={phoneNumber}
          onChangeText={text => {
            setPhoneNumber(text);
            if (numberError) setNumberError(null);
          }}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          autoComplete="tel"
          error={numberError ?? undefined}
        />
        <PrimaryButton label="Continue" onPress={confirmMobileNumber} />
      </Screen>
    );
  }

  if (deviceType === "landline") {
    return (
      <Screen>
        <SetupProgress currentStep={3} />
        <Pressable onPress={() => setDeviceType(null)} accessibilityRole="button" style={styles.backLink}>
          <Text style={styles.backLinkText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">Which landline provider do you have?</Text>
        <Text style={styles.subtitle}>This just tells us the right dialling code to show you next.</Text>
        <View style={styles.list}>
          {LANDLINE_PROVIDERS.map(({ provider, label }) => (
            <Pressable
              key={provider}
              onPress={() => selectProvider(provider)}
              style={({ pressed }) => [styles.listItem, pressed && styles.listItemPressed]}
              accessibilityRole="button"
              accessibilityLabel={label}
            >
              <Text style={styles.listItemText}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <SetupProgress currentStep={3} />
      <Text style={styles.title} accessibilityRole="header">What are we setting up protection on?</Text>
      <Text style={styles.subtitle}>Pick the phone whose calls you want screened.</Text>
      <View style={styles.cards}>
        {DEVICE_OPTIONS.map(({ type, label, icon }) => (
          <Pressable
            key={type}
            onPress={() => selectDevice(type)}
            style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
            accessibilityRole="button"
            accessibilityLabel={label}
          >
            <Ionicons name={icon} size={32} color={colors.accent} style={styles.cardIcon} accessibilityElementsHidden importantForAccessibility="no" />
            <Text style={styles.cardText}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  backLink: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: "center",
    marginLeft: -spacing.sm,
  },
  backLinkText: {
    color: colors.accent,
    fontWeight: "600",
    fontSize: 15,
  },
  title: {
    ...typography.hero,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  subtitle: {
    ...typography.body,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  cards: {
    gap: spacing.md,
  },
  card: {
    minHeight: MIN_TOUCH_TARGET * 1.5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },
  cardPressed: {
    borderColor: colors.accent,
  },
  cardIcon: {
    marginBottom: spacing.xs,
  },
  cardText: {
    ...typography.title,
    color: colors.text,
  },
  list: {
    gap: spacing.sm,
  },
  listItem: {
    minHeight: MIN_TOUCH_TARGET,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
  listItemPressed: {
    borderColor: colors.accent,
  },
  listItemText: {
    ...typography.body,
    color: colors.text,
  },
});
