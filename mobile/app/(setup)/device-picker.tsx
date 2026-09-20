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
import { Text, View, Pressable, StyleSheet, ActivityIndicator, TextInput, Image } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "../../components/Screen";
import { Banner } from "../../components/Banner";
import { PrimaryButton } from "../../components/PrimaryButton";
import { checkCarrierCompatibility, setHouseholdLandline, setHouseholdIphone, joinWaitingList, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/AuthContext";
import { saveActivationDevice } from "../../lib/activationDeviceStorage";
import { MOBILE_CARRIERS } from "../../lib/carriers";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../lib/theme";
import type { DeviceType, LandlineProvider, MobileCarrierKey, TariffType } from "../../lib/types";

// IOS_COMING_SOON (2026-09-19, services/featureFlags.js): the iPhone
// option always stays in this list — removing it would leave an iPhone
// customer with no idea HCG exists for them at all — but label/icon mark
// it clearly, and selectDevice below routes it to its own dead-end step
// rather than ever reaching the carrier/tariff/consent/Stripe flow.
// Backed by a real server-side block regardless (households.device_type
// = "iphone", evaluateHouseholdCheckoutEligibility) — this UI marking is
// the honest, friendly version of that same fact, not the thing
// enforcing it. Once IOS_COMING_SOON is false, this label/behaviour
// reverting to the normal iPhone flow is the one piece of this file that
// would need a source change (and a new build) — everything else here
// is unaffected either way.
// 2026-09-20 — iPhone/Android used to render via Ionicons' generic
// logo-apple/logo-android glyphs (a stock icon-font rendering, not real
// platform iconography). Replaced with real image assets:
//  - Android uses a proper silhouette of Google's own Android robot
//    mark ("bugdroid"), which Google explicitly open-licenses (CC BY
//    3.0) for exactly this kind of third-party use, including
//    single-colour treatments like this one.
//  - iPhone deliberately does NOT use Apple's bitten-apple logo — that
//    mark is Apple's trademark, and third-party apps are not free to
//    use it to represent "iPhone" without Apple's own approval. A
//    generic smartphone-device silhouette (rounded frame, notch, home
//    indicator) honestly represents the device category without that
//    risk. Landline keeps its existing Ionicons "call" glyph — that's
//    a generic pictogram, not another platform's brand mark, so there
//    is no equivalent concern.
// See mobile/assets/android-device-mark.png and iphone-device-mark.png.
const DEVICE_OPTIONS: {
  type: DeviceType;
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  iconSource?: number;
}[] = [
  { type: "iphone", label: "iPhone — Coming soon", iconSource: require("../../assets/iphone-device-mark.png") },
  { type: "android", label: "Android phone", iconSource: require("../../assets/android-device-mark.png") },
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
  | { name: "blocked"; customerState: "not_currently_supported" | "needs_confirmation" }
  | { name: "ios-coming-soon" }
  | { name: "landline-provider-unsupported"; provider: LandlineProvider };

export default function DevicePicker() {
  const { session } = useAuth();
  const [deviceType, setDeviceType] = useState<DeviceType | null>(null);
  const [step, setStep] = useState<Step>({ name: "device" });
  const [error, setError] = useState<string | null>(null);
  const [waitingListEmail, setWaitingListEmail] = useState("");
  const [waitingListStatus, setWaitingListStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  // IOS_COMING_SOON (2026-09-19): persists device_type="iphone" server-
  // side (setHouseholdIphone, migration 041) — same discipline as
  // landline below, real server state, not a client-only shortcut — then
  // shows the dead-end step regardless of what the backend actually
  // returned, since this UI's job while the flag is on is simply "never
  // let an iPhone selection reach carrier/consent/Stripe." A network
  // failure here doesn't block the customer from seeing the coming-soon
  // message; it only means the household record won't yet reflect
  // "iphone" — genuinely low-stakes, so the step shows either way rather
  // than stranding the customer on a spinner for a non-critical write.
  function selectDevice(type: DeviceType) {
    setDeviceType(type);
    if (type === "landline") {
      setStep({ name: "landline-provider" });
      return;
    }
    if (type === "iphone") {
      setStep({ name: "ios-coming-soon" });
      setHouseholdIphone(session?.access_token).catch(() => {});
      return;
    }
    setStep({ name: "carrier" });
  }

  // One reusable submit for both waiting-list reasons this screen can
  // reach — iOS coming-soon and an unsupported landline provider. Extra
  // fields (providerKey/deviceType) are passed straight through to
  // joinWaitingList; which ones are relevant depends on reason, exactly
  // matching migration 042's own schema.
  async function submitWaitingList(reason: "ios_coming_soon" | "unsupported_carrier", extra: { providerKey?: string; deviceType?: string }) {
    const trimmed = waitingListEmail.trim();
    if (!trimmed || trimmed.indexOf("@") === -1) {
      setWaitingListStatus("error");
      return;
    }
    setWaitingListStatus("saving");
    try {
      await joinWaitingList({ email: trimmed, reason, ...extra });
      setWaitingListStatus("saved");
    } catch {
      setWaitingListStatus("error");
    }
  }

  function resetWaitingListForm() {
    setWaitingListEmail("");
    setWaitingListStatus("idle");
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
  //
  // 2026-09-19 launch-safety correction: the provider itself is now sent
  // (migration 043) and its real evaluation checked — "other" or any
  // unaudited landline provider no longer proceeds to Subscribe on the
  // unproven assumption a default dial code will work; it goes to its
  // own dead-end step instead, same shape as the iOS coming-soon one.
  async function selectLandlineProvider(provider: LandlineProvider) {
    setStep({ name: "checking" });
    setError(null);
    resetWaitingListForm();
    try {
      const result = await setHouseholdLandline(provider, session?.access_token);
      if (result.customerState === "landline_provider_unsupported") {
        setStep({ name: "landline-provider-unsupported", provider });
        return;
      }
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

  if (step.name === "ios-coming-soon") {
    return (
      <Screen>
        <Pressable onPress={() => setStep({ name: "device" })} accessibilityRole="button" style={styles.backLink}>
          <Text style={styles.backLinkText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">Home Call Guard for iPhone is coming soon</Text>
        <Text style={styles.subtitle}>
          We're waiting for final approval of our iPhone app. Home Call Guard isn't currently available for new
          iPhone customers.{"\n\n"}Join the waiting list and we'll let you know as soon as it's available.
        </Text>
        {waitingListStatus === "saved" ? (
          <Banner variant="notice" message="Thanks — we'll email you as soon as Home Call Guard for iPhone is available." />
        ) : (
          <>
            <Text style={styles.subtitle}>Email address</Text>
            <TextInput
              value={waitingListEmail}
              onChangeText={setWaitingListEmail}
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.emailInput}
            />
            {waitingListStatus === "error" && (
              <Banner variant="error" message="Please enter a valid email address, or check your connection and try again." />
            )}
            <PrimaryButton
              label={waitingListStatus === "saving" ? "Joining…" : "Join the waiting list"}
              onPress={() => submitWaitingList("ios_coming_soon", { deviceType: "iphone" })}
            />
          </>
        )}
        <PrimaryButton
          label="Choose a different option"
          variant="secondary"
          onPress={() => setStep({ name: "device" })}
        />
      </Screen>
    );
  }

  if (step.name === "landline-provider-unsupported") {
    return (
      <Screen>
        <Pressable onPress={() => setStep({ name: "landline-provider" })} accessibilityRole="button" style={styles.backLink}>
          <Text style={styles.backLinkText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">We don't currently support this provider</Text>
        <Text style={styles.subtitle}>
          We don't currently have confirmed setup instructions for your landline provider. Join our waiting list
          and we'll let you know when your provider is supported.
        </Text>
        {waitingListStatus === "saved" ? (
          <Banner variant="notice" message="Thanks — we'll email you as soon as your landline provider is supported." />
        ) : (
          <>
            <Text style={styles.subtitle}>Email address</Text>
            <TextInput
              value={waitingListEmail}
              onChangeText={setWaitingListEmail}
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.emailInput}
            />
            {waitingListStatus === "error" && (
              <Banner variant="error" message="Please enter a valid email address, or check your connection and try again." />
            )}
            <PrimaryButton
              label={waitingListStatus === "saving" ? "Joining…" : "Join the waiting list"}
              onPress={() => submitWaitingList("unsupported_carrier", { providerKey: step.provider, deviceType: "landline" })}
            />
          </>
        )}
        <PrimaryButton
          label="Choose a different provider"
          variant="secondary"
          onPress={() => setStep({ name: "landline-provider" })}
        />
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
        {DEVICE_OPTIONS.map(({ type, label, icon, iconSource }) => (
          <Pressable
            key={type}
            onPress={() => selectDevice(type)}
            style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
            accessibilityRole="button"
            accessibilityLabel={label}
          >
            {iconSource ? (
              <Image source={iconSource} style={styles.cardIconImage} resizeMode="contain" accessibilityElementsHidden importantForAccessibility="no" />
            ) : (
              <Ionicons name={icon!} size={32} color={colors.accent} style={styles.cardIcon} accessibilityElementsHidden importantForAccessibility="no" />
            )}
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
  emailInput: {
    minHeight: MIN_TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.md,
    color: colors.text,
    marginBottom: spacing.md,
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
  cardIconImage: {
    width: 40,
    height: 40,
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
