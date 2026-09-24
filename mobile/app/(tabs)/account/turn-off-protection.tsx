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
import { Text, View, ActivityIndicator, StyleSheet } from "react-native";
import { useFocusEffect } from "expo-router";
import { Screen } from "../../../components/Screen";
import { Banner } from "../../../components/Banner";
import { fetchActivationInstructions, fetchActivationDevice } from "../../../lib/api";
import { useAuth } from "../../../lib/AuthContext";
import { loadActivationDevice, saveActivationDevice, StoredActivationDevice } from "../../../lib/activationDeviceStorage";
import { colors, spacing, typography } from "../../../lib/theme";

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

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setState("loading");

      function showInstructionsFor(device: StoredActivationDevice) {
        return fetchActivationInstructions(device.deviceType, device.provider, session?.access_token)
          .then(result => {
            if (cancelled) return;
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

  // Carrier-instruction correction (2026-09-24): mirrors upload.html's
  // own renderDeactivationResult, the three-way branch this screen never
  // had — cancelCode present (mmi), native_settings (no code, a guidance
  // note instead), or genuinely unknown (honest fallback, never a
  // guessed code).
  return (
    <Screen>
      <Text style={styles.title}>Need to turn protection off?</Text>
      {cancelCode ? (
        <>
          <Text style={styles.body}>
            Dial the code below from the phone you forwarded to Home Call Guard — this returns it to normal
            calling straight away.
          </Text>
          <View style={styles.codeBox}>
            <Text style={styles.code} selectable>{cancelCode}</Text>
          </View>
        </>
      ) : cancelCodeMethod === "native_settings" ? (
        <Banner
          variant="notice"
          message={cancelCodeNote || "Use your phone's native call forwarding settings (Phone app settings, or Settings > Phone/Calls) to turn this off — a dial code isn't reliable on this network."}
        />
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
  code: {
    fontSize: 24,
    fontWeight: "700",
    color: colors.accent,
    letterSpacing: 0.5,
  },
});
