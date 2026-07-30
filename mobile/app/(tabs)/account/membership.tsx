// D1 — Manage Membership. Per APP_VISUAL_SPECIFICATION.md: real,
// server-derived status only — never a client-guessed one. "Manage
// membership" hands off to Stripe's Billing Portal in an in-app browser,
// kept deliberately thin rather than natively rebuilt (Stripe's hosted
// UI is already well-designed and well-tested).
import { useCallback, useState } from "react";
import { Text, View, StyleSheet, ActivityIndicator } from "react-native";
import { router, useFocusEffect } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Screen } from "../../../components/Screen";
import { PrimaryButton } from "../../../components/PrimaryButton";
import { Banner } from "../../../components/Banner";
import { fetchDashboard, createPortalSession, ApiError, NotEntitledError } from "../../../lib/api";
import type { DashboardResponse } from "../../../lib/types";
import { colors, spacing, typography } from "../../../lib/theme";

const STATUS_LABELS: Record<DashboardResponse["membership"]["status"], string> = {
  active: "Active",
  trial: "Free trial",
  payment_issue: "Payment issue",
  cancelled: "Cancelling at period end",
};

export default function Membership() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notEntitled, setNotEntitled] = useState(false);

  useFocusEffect(
    useCallback(() => {
      fetchDashboard()
        .then(result => {
          setData(result);
          setNotEntitled(false);
        })
        .catch(err => {
          if (err instanceof NotEntitledError) setNotEntitled(true);
        });
    }, [])
  );

  async function handleManage() {
    setError(null);
    setIsOpeningPortal(true);
    try {
      const { url } = await createPortalSession();
      await WebBrowser.openBrowserAsync(url);
    } catch (err) {
      if (err instanceof ApiError && err.code === "not_manageable") {
        setError("This membership doesn't have billing to manage.");
      } else {
        setError("We couldn't open billing management. Please try again.");
      }
    } finally {
      setIsOpeningPortal(false);
    }
  }

  if (notEntitled) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <Text style={styles.status}>No active membership</Text>
          <View style={styles.notEntitledButton}>
            <PrimaryButton label="Start protection" onPress={() => router.push("/(setup)/welcome")} />
          </View>
        </View>
      </Screen>
    );
  }

  if (!data) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} size="large" />
        </View>
      </Screen>
    );
  }

  const { membership } = data;

  return (
    <Screen>
      <Text style={styles.plan}>{membership.planName}</Text>
      <Text style={styles.price}>{membership.priceLabel}</Text>
      <Text style={styles.status}>{STATUS_LABELS[membership.status]}</Text>

      {membership.nextBillingDate && (
        <Text style={styles.detail}>Next billing date: {new Date(membership.nextBillingDate).toLocaleDateString("en-GB")}</Text>
      )}
      {membership.status === "cancelled" && membership.accessUntil && (
        <Text style={styles.detail}>
          Protection continues until {new Date(membership.accessUntil).toLocaleDateString("en-GB")}
        </Text>
      )}
      {membership.status === "trial" && membership.trialEndDate && (
        <Text style={styles.detail}>Trial ends: {new Date(membership.trialEndDate).toLocaleDateString("en-GB")}</Text>
      )}

      {error && <Banner variant="error" message={error} />}

      {membership.manageable && (
        <PrimaryButton label="Manage membership" onPress={handleManage} loading={isOpeningPortal} />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },
  notEntitledButton: {
    marginTop: spacing.md,
    alignSelf: "stretch",
  },
  plan: {
    ...typography.hero,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  price: {
    ...typography.body,
    color: colors.textMuted,
    marginBottom: spacing.md,
  },
  status: {
    ...typography.title,
    color: colors.accent,
    marginBottom: spacing.md,
  },
  detail: {
    ...typography.body,
    color: colors.text,
    marginBottom: spacing.xs,
  },
});
