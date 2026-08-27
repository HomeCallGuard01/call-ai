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
import { useCallback, useState } from "react";
import { Text, View, ActivityIndicator, StyleSheet } from "react-native";
import { useFocusEffect } from "expo-router";
import { Screen } from "../../../components/Screen";
import { Banner } from "../../../components/Banner";
import { fetchActivationInstructions } from "../../../lib/api";
import { useAuth } from "../../../lib/AuthContext";
import { loadActivationDevice } from "../../../lib/activationDeviceStorage";
import { colors, spacing, typography } from "../../../lib/theme";

type ScreenState = "loading" | "ready" | "no_device_on_record" | "unavailable";

export default function TurnOffProtection() {
  const { session } = useAuth();
  const [state, setState] = useState<ScreenState>("loading");
  const [cancelCode, setCancelCode] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setState("loading");

      loadActivationDevice()
        .then(device => {
          if (cancelled) return;
          if (!device) {
            setState("no_device_on_record");
            return;
          }
          return fetchActivationInstructions(device.deviceType, device.provider, undefined, session?.access_token)
            .then(result => {
              if (cancelled) return;
              setCancelCode(result.cancelCode);
              setState("ready");
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

  return (
    <Screen>
      <Text style={styles.title}>Need to turn protection off?</Text>
      <Text style={styles.body}>
        Dial the code below from the phone you forwarded to Home Call Guard — this returns it to normal calling
        straight away.
      </Text>
      <View style={styles.codeBox}>
        <Text style={styles.code} selectable>{cancelCode}</Text>
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
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 14,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.lg,
  },
  code: {
    fontSize: 28,
    fontWeight: "700",
    color: colors.accent,
    letterSpacing: 1,
  },
});
