// D-new — "Need to turn protection off?" Real iPhone testing
// (2026-08-08/09) found the carrier's undo code was computed
// server-side (services/activationInstructions.js) but never shown
// anywhere, and only ever reachable (once shown) on the one-time
// activation screen — gone the moment setup was behind the customer.
// This is that same information, kept reachable from the Account tab
// for as long as the account exists. Re-fetches the real instructions
// from the same endpoint the activation screen uses (never a
// client-side guess at the code — provider-specific cancellation logic,
// e.g. Virgin's ##21# vs the standard #21#, lives in exactly one place:
// services/activationInstructions.js) using whichever device/provider
// was persisted at activation time (lib/activationDeviceStorage.ts).
//
// 2026-09-19 fix — real-device finding: SecureStore (and this whole
// local record) is wiped by an app uninstall/reinstall or a device
// change, at which point this screen had no way to recover the
// device/provider at all, even though the same information is durable
// server-side (households.device_type / carrier_provider_key). When the
// local record is missing, this now falls back to GET
// /api/v1/me/activation-device (fetchActivationDevice) and re-caches
// whatever it finds locally, so this only round-trips once per
// reinstall. Behaviour when the local record already exists is
// completely unchanged.
import { useCallback, useState } from "react";
import { Text, View, ActivityIndicator, StyleSheet, Platform, Linking, Pressable } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect } from "expo-router";
import { Screen } from "../../../components/Screen";
import { Banner } from "../../../components/Banner";
import { fetchActivationInstructions, fetchActivationDevice } from "../../../lib/api";
import { useAuth } from "../../../lib/AuthContext";
import { loadActivationDevice, saveActivationDevice, StoredActivationDevice } from "../../../lib/activationDeviceStorage";
import { settingsForwardingNote, IOS_SETTINGS_DEACTIVATION_NOTE } from "../../../lib/forwardingSettingsCopy";
import {
  buildDialerUrl,
  canAutoOpenDialer,
  planTurnOffForwarding,
  ANDROID_FORWARDING_SETTINGS_PATH,
  AFTER_TURN_OFF_NOTE,
} from "../../../lib/dialerLink";
import { PrimaryButton } from "../../../components/PrimaryButton";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../../lib/theme";

type ScreenState = "loading" | "ready" | "no_device_on_record" | "unavailable";

export default function TurnOffProtection() {
  const { session } = useAuth();
  const [state, setState] = useState<ScreenState>("loading");
  const [cancelCode, setCancelCode] = useState<string | null>(null);
  // Carrier-instruction correction (2026-09-24) — real gap found: this
  // screen always rendered cancelCode as if it were a dialable string,
  // which is null for any native_settings carrier (Three, and now
  // giffgaff) — customers on those networks saw a blank code box with no
  // usable instruction at all. cancelCodeMethod/cancelCodeNote were
  // already returned by the backend but never read here.
  const [cancelCodeMethod, setCancelCodeMethod] = useState<"mmi" | "native_settings" | "unknown" | null>(null);
  const [cancelCodeNote, setCancelCodeNote] = useState<string | null>(null);
  // WS3 (2026-10-10): which device the forwarding is on — decides whether
  // this phone's own dialer may be opened (only for this phone's own line,
  // see lib/dialerLink.ts canAutoOpenDialer).
  const [deviceType, setDeviceType] = useState<string | null>(null);
  const [dialerError, setDialerError] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setState("loading");

      function showInstructionsFor(device: StoredActivationDevice) {
        return fetchActivationInstructions(device.deviceType, device.provider, session?.access_token)
          .then(result => {
            if (cancelled) return;
            setDeviceType(device.deviceType);
            setCancelCode(result.cancelCode);
            setCancelCodeMethod(result.cancelCodeMethod);
            setCancelCodeNote(result.cancelCodeNote);
            setState("ready");
          })
          .catch(() => {
            if (!cancelled) setState("unavailable");
          });
      }

      loadActivationDevice()
        .then(device => {
          if (cancelled) return;
          if (device) return showInstructionsFor(device);

          // No local record — most commonly an app uninstall/reinstall
          // or a device change, both of which wipe SecureStore but
          // leave the household's real device/provider intact
          // server-side. Fall back to that, then re-cache locally.
          return fetchActivationDevice(session?.access_token)
            .then(backendDevice => {
              if (cancelled) return;
              if (!backendDevice.deviceType) {
                setState("no_device_on_record");
                return;
              }
              const resolved: StoredActivationDevice = {
                deviceType: backendDevice.deviceType,
                provider: backendDevice.provider ?? undefined,
              };
              saveActivationDevice(resolved).catch(() => {});
              return showInstructionsFor(resolved);
            })
            .catch(() => {
              if (!cancelled) setState("unavailable");
            });
        })
        .catch(() => {
          if (!cancelled) setState("unavailable");
        });

      return () => {
        cancelled = true;
      };
    }, [session?.access_token])
  );

  if (state === "loading") {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} size="large" />
        </View>
      </Screen>
    );
  }

  if (state === "no_device_on_record" || state === "unavailable") {
    return (
      <Screen>
        <Text style={styles.title}>Need to turn protection off?</Text>
        <Banner
          variant="notice"
          message={
            state === "no_device_on_record"
              ? "We don't have a record of which phone you activated on this device yet. Contact support and we'll help you turn off call forwarding."
              : "We couldn't load this right now. Please try again, or contact support and we'll help you turn off call forwarding."
          }
        />
      </Screen>
    );
  }

  // WS3 (2026-10-10): the honest "return to normal mobile" path, reachable
  // from Account and from the screening-paused / allowance banners on Home.
  // lib/dialerLink.ts planTurnOffForwarding decides how to present the
  // server's cancel code: Android opens the Phone app pre-filled (the
  // customer presses Call — never automatic); iPhone shows the code and the
  // Settings path; any other device's code is shown, never dialled here. The
  // three-way server branch below (code / native_settings / unknown,
  // carrier-instruction correction 2026-09-24) is unchanged in substance.
  const plan = planTurnOffForwarding({ deviceType, platform: Platform.OS, cancelCode, cancelCodeMethod });
  const ownLine = canAutoOpenDialer(deviceType ?? "");

  async function handleOpenPhone() {
    if (!plan.openDialer || !plan.code) return;
    setDialerError(false);
    const url = buildDialerUrl(plan.code);
    try {
      const canOpen = await Linking.canOpenURL(url);
      if (!canOpen) {
        setDialerError(true);
        return;
      }
      await Linking.openURL(url);
    } catch {
      setDialerError(true);
    }
  }

  async function handleCopyCode() {
    if (!plan.code) return;
    await Clipboard.setStringAsync(plan.code);
    setCodeCopied(true);
  }

  return (
    <Screen>
      <Text style={styles.title}>Need to turn protection off?</Text>
      {plan.code ? (
        <>
          <Text style={styles.body}>
            Dial the code below from the phone you forwarded to Home Call Guard — this returns it to normal
            calling straight away.
          </Text>
          <View style={styles.codeBox}>
            <Text style={styles.code} selectable>{plan.code}</Text>
          </View>
          {plan.caveat && <Text style={styles.caveat}>{plan.caveat}</Text>}

          {plan.openDialer ? (
            <View style={styles.steps}>
              <Text style={styles.step}>1. Tap Open Phone app — it opens with the code already filled in</Text>
              <Text style={styles.step}>2. Press Call. Home Call Guard can't press it for you</Text>
              <Text style={styles.step}>3. Your phone should show a message saying call forwarding is off</Text>
            </View>
          ) : null}

          {dialerError && (
            <Banner variant="error" message="We couldn't open your Phone app automatically. Dial the code above yourself instead." />
          )}
          {plan.openDialer && <PrimaryButton label="Open Phone app" onPress={handleOpenPhone} />}

          {Platform.OS === "ios" && deviceType === "iphone" && (
            <>
              <Pressable onPress={handleCopyCode} accessibilityRole="button" style={styles.copyLink}>
                <Text style={styles.copyLinkText}>{codeCopied ? "Copied!" : "Copy code"}</Text>
              </Pressable>
              <Text style={styles.body}>
                Open the Phone app's Keypad, paste or type the code and press Call. {IOS_SETTINGS_DEACTIVATION_NOTE}
              </Text>
            </>
          )}
          {plan.mode === "standard_code" && <Text style={styles.body}>{ANDROID_FORWARDING_SETTINGS_PATH}</Text>}
          {ownLine && <Text style={styles.body}>{AFTER_TURN_OFF_NOTE}</Text>}
        </>
      ) : cancelCodeMethod === "native_settings" || plan.mode === "settings" ? (
        <>
          <Banner
            variant="notice"
            message={settingsForwardingNote("deactivate", cancelCodeNote, Platform.OS) || "Use your phone's native call forwarding settings (Phone app settings, or Settings > Phone/Calls) to turn this off — a dial code isn't reliable on this network."}
          />
          {ownLine && <Text style={styles.body}>{AFTER_TURN_OFF_NOTE}</Text>}
        </>
      ) : (
        <Banner
          variant="notice"
          message={cancelCodeNote || "We don't have a confirmed removal code for your network yet. Check your phone's native call forwarding settings, or contact support for help."}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    ...typography.hero,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  body: {
    ...typography.body,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  codeBox: {
    borderWidth: 1.5,
    borderColor: colors.accent,
    borderRadius: 14,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.accentMuted,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.lg,
  },
  caveat: {
    ...typography.body,
    color: colors.textMuted,
    marginTop: spacing.md,
  },
  steps: {
    marginTop: spacing.lg,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  step: {
    ...typography.body,
    color: colors.text,
  },
  copyLink: {
    alignSelf: "center",
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
  copyLinkText: {
    ...typography.body,
    color: colors.accent,
    fontWeight: "600",
  },
  code: {
    fontSize: 24,
    fontWeight: "700",
    color: colors.accent,
    letterSpacing: 0.5,
  },
});
