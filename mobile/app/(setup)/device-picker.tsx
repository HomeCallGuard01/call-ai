// Device + carrier-compatibility check. Relocated (2026-09-13) to run
// BEFORE Subscribe/payment, not after — carrier compatibility must be
// established before a customer is ever asked to pay (see the carrier-
// onboarding-gate audit: this was previously step 3, well after payment,
// which meant the checkout-time backend gate in routes/mobileApi.js was
// the ONLY enforcement, surfaced to the customer as a generic "couldn't
// start checkout" error with no real explanation).
//
// Still the same device-type/landline-provider UI as before (large
// tappable cards, per APP_VISUAL_SPECIFICATION.md) — landline is
// unaffected by any of this (providerPolicy.js only covers UK mobile
// networks; landline forwarding is a completely separate mechanism, see
// services/activationInstructions.js's LANDLINE_PROVIDERS). iPhone/
// Android now additionally ask which mobile network, and — only when
// services/providerPolicy.js says it actually matters (today: Vodafone
// only) — which tariff, before ever reaching Subscribe.
//
// No SetupProgress bar here, matching welcome/confirmation/complete —
// this is a pre-flight eligibility check, not one of the three numbered
// setup steps (see lib/setupFlow.ts).
//
// Device/provider selection is persisted immediately via
// activationDeviceStorage (the same mechanism activate.tsx and the
// Account-tab "Turn off protection"/"Set up call forwarding" screens
// already rely on) rather than carried through route params — this
// screen is no longer adjacent to activate.tsx in the flow, so params
// alone would not survive the Subscribe → Confirmation → Contacts hops
// in between.
import { useState } from "react";
import { Text, View, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "../../components/Screen";
import { Banner } from "../../components/Banner";
import { PrimaryButton } from "../../components/PrimaryButton";
import { checkCarrierCompatibility, setHouseholdLandline, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/AuthContext";
import { saveActivationDevice } from "../../lib/activationDeviceStorage";
import { MOBILE_CARRIERS } from "../../lib/carriers";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../lib/theme";
import type { DeviceType, LandlineProvider, MobileCarrierKey, TariffType } from "../../lib/types";

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

const TARIFF_OPTIONS: { type: TariffType; label: string }[] = [
  { type: "pay_monthly", label: "Pay monthly (contract)" },
  { type: "payg", label: "Pay as you go" },
];

type Step =
  | { name: "device" }
  | { name: "landline-provider" }
  | { name: "carrier" }
  | { name: "tariff"; provider: MobileCarrierKey }
  | { name: "checking" }
  | { name: "blocked"; customerState: "not_currently_supported" | "needs_confirmation" };

export default function DevicePicker() {
  const { session } = useAuth();
  const [deviceType, setDeviceType] = useState<DeviceType | null>(null);
  const [step, setStep] = useState<Step>({ name: "device" });
  const [error, setError] = useState<string | null>(null);

  function selectDevice(type: DeviceType) {
    setDeviceType(type);
    if (type === "landline") {
      setStep({ name: "landline-provider" });
      return;
    }
    setStep({ name: "carrier" });
  }

  // 2026-09-16 fix (the landline checkout-eligibility defect found
  // during PR #39 staging acceptance testing): this used to only save
  // deviceType locally (saveActivationDevice, AsyncStorage) and navigate
  // straight on — the backend never learned this household is landline
  // at all, so households.device_type stayed null forever, which the
  // checkout gate correctly treats as "unclassified mobile" and blocks.
  // Landline now persists device_type="landline" server-side first
  // (setHouseholdLandline — migration 040), the same authoritative
  // signal evaluateHouseholdCheckoutEligibility reads at the real
  // /api/v1/billing/create-checkout-session gate.
  async function selectLandlineProvider(provider: LandlineProvider) {
    setStep({ name: "checking" });
    setError(null);
    try {
      await setHouseholdLandline(session?.access_token);
      saveActivationDevice({ deviceType: "landline", provider });
      router.push("/(setup)/subscribe");
    } catch (err) {
      setError("We couldn't save your selection just now. Please try again.");
      setStep({ name: "landline-provider" });
    }
  }

  async function evaluate(provider: MobileCarrierKey, tariffType?: TariffType) {
    setStep({ name: "checking" });
    setError(null);
    try {
      const result = await checkCarrierCompatibility(provider, tariffType, session?.access_token);
      if (result.reason === "tariff_type_required") {
        setStep({ name: "tariff", provider });
        return;
      }
      if (result.canProceedToPayment) {
        // deviceType is guaranteed set here (only reachable via the
        // iPhone/Android branch of selectDevice) — carrier itself lives
        // server-side (households.carrier_provider_key, already written
        // by checkCarrierCompatibility above), so only deviceType needs
        // persisting locally for activate.tsx/the Account-tab screens.
        saveActivationDevice({ deviceType: deviceType as DeviceType });
        router.push("/(setup)/subscribe");
        return;
      }
      // 2026-09-16 fix: never carries result.reason (the backend's own
      // internal policy string) through to the rendered "blocked" step
      // any more — only the customerState category, which decides fixed,
      // non-technical copy (see the "blocked" render branch below).
      setStep({ name: "blocked", customerState: result.customerState === "needs_confirmation" ? "needs_confirmation" : "not_currently_supported" });
    } catch (err) {
      setError(err instanceof ApiError ? "We couldn't check your network. Please try again." : "Something went wrong.");
      setStep({ name: "carrier" });
    }
  }

  function selectCarrier(provider: MobileCarrierKey) {
    evaluate(provider);
  }

  function selectTariff(provider: MobileCarrierKey, tariffType: TariffType) {
    evaluate(provider, tariffType);
  }

  if (step.name === "landline-provider") {
    return (
      <Screen>
        <Pressable onPress={() => setStep({ name: "device" })} accessibilityRole="button" style={styles.backLink}>
          <Text style={styles.backLinkText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">Which landline provider do you have?</Text>
        <Text style={styles.subtitle}>This just tells us the right dialling code to show you next.</Text>
        <View style={styles.list}>
          {LANDLINE_PROVIDERS.map(({ provider, label }) => (
            <Pressable
              key={provider}
              onPress={() => selectLandlineProvider(provider)}
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

  if (step.name === "carrier") {
    return (
      <Screen>
        <Pressable onPress={() => setStep({ name: "device" })} accessibilityRole="button" style={styles.backLink}>
          <Text style={styles.backLinkText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">Which mobile network do you use?</Text>
        <Text style={styles.subtitle}>We need to check your network supports call forwarding before you subscribe.</Text>
        {error && <Banner variant="error" message={error} />}
        <View style={styles.list}>
          {MOBILE_CARRIERS.map(({ key, label }) => (
            <Pressable
              key={key}
              onPress={() => selectCarrier(key)}
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

  if (step.name === "tariff") {
    const { provider } = step;
    return (
      <Screen>
        <Pressable onPress={() => setStep({ name: "carrier" })} accessibilityRole="button" style={styles.backLink}>
          <Text style={styles.backLinkText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">Pay monthly or pay as you go?</Text>
        <Text style={styles.subtitle}>Call forwarding works differently depending on your tariff.</Text>
        {error && <Banner variant="error" message={error} />}
        <View style={styles.list}>
          {TARIFF_OPTIONS.map(({ type, label }) => (
            <Pressable
              key={type}
              onPress={() => selectTariff(provider, type)}
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

  if (step.name === "checking") {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} size="large" accessibilityLabel="Checking your network" />
        </View>
      </Screen>
    );
  }

  if (step.name === "blocked") {
    // Fixed, non-technical copy chosen only by customerState — never
    // the backend's own internal policy reason string (2026-09-16 fix).
    const message = step.customerState === "needs_confirmation"
      ? "We're still confirming Home Call Guard works with your network. We don't want to take your payment until we're sure it will work for you."
      : "Unfortunately, this isn't currently compatible with Home Call Guard. You can use Home Call Guard with another supported mobile network or plan.";
    return (
      <Screen>
        <Text style={styles.title} accessibilityRole="header">We can't protect this network yet</Text>
        <Banner variant="notice" message={message} />
        <PrimaryButton label="Try a different network" onPress={() => setStep({ name: "carrier" })} />
        <PrimaryButton
          label="Contact support"
          variant="secondary"
          onPress={() => router.push("/(tabs)/account/support")}
        />
      </Screen>
    );
  }

  return (
    <Screen>
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
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
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
