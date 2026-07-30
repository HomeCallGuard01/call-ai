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

  function selectDevice(type: DeviceType) {
    setDeviceType(type);
    if (type !== "landline") {
      router.push({ pathname: "/(setup)/activate", params: { deviceType: type } });
    }
  }

  function selectProvider(provider: LandlineProvider) {
    router.push({ pathname: "/(setup)/activate", params: { deviceType: "landline", provider } });
  }

  if (deviceType === "landline") {
    return (
      <Screen>
        <Text style={styles.title}>Which landline provider do you have?</Text>
        <View style={styles.list}>
          {LANDLINE_PROVIDERS.map(({ provider, label }) => (
            <Pressable
              key={provider}
              onPress={() => selectProvider(provider)}
              style={({ pressed }) => [styles.listItem, pressed && styles.listItemPressed]}
              accessibilityRole="button"
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
      <Text style={styles.title}>What are we setting up protection on?</Text>
      <View style={styles.cards}>
        {DEVICE_OPTIONS.map(({ type, label, icon }) => (
          <Pressable
            key={type}
            onPress={() => selectDevice(type)}
            style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
            accessibilityRole="button"
          >
            <Ionicons name={icon} size={32} color={colors.accent} style={styles.cardIcon} />
            <Text style={styles.cardText}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: {
    ...typography.hero,
    color: colors.text,
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
