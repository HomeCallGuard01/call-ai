// D1 — Manage Membership. Per APP_VISUAL_SPECIFICATION.md: real,
// server-derived status only — never a client-guessed one. "Manage
// membership" hands off to Stripe's Billing Portal in an in-app browser,
// kept deliberately thin rather than natively rebuilt (Stripe's hosted
// UI is already well-designed and well-tested).
import { useCallback, useState } from "react";
import { Text, View, StyleSheet, ActivityIndicator, Linking, Platform } from "react-native";
import { router, useFocusEffect } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Screen } from "../../../components/Screen";
import { PrimaryButton } from "../../../components/PrimaryButton";
import { Banner } from "../../../components/Banner";
import { fetchDashboard, createPortalSession, ApiError, NotEntitledError } from "../../../lib/api";
import { restorePurchases as restoreApplePurchases, isEntitled } from "../../../lib/purchases";
import { useAuth } from "../../../lib/AuthContext";
import type { DashboardResponse } from "../../../lib/types";
import { colors, spacing, typography } from "../../../lib/theme";

// Apple's own "manage subscriptions" deep link — the only place an
// Apple-billed subscription can actually be changed/cancelled from;
// Stripe's Billing Portal has no concept of it. Documented, stable
// Apple URL scheme, not an undocumented trick.
const APPLE_MANAGE_SUBSCRIPTIONS_URL = "itms-apps://apps.apple.com/account/subscriptions";

const STATUS_LABELS: Record<DashboardResponse["membership"]["status"], string> = {
  active: "Active",
  trial: "Free trial",
  payment_issue: "Payment issue",
  cancelled: "Cancelling at period end",
};

export default function Membership() {
  const { session } = useAuth();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notEntitled, setNotEntitled] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      fetchDashboard(session?.access_token)
        .then(result => {
          setData(result);
          setNotEntitled(false);
        })
        .catch(err => {
          if (err instanceof NotEntitledError) setNotEntitled(true);
        });
    }, [session?.access_token])
  );

  async function handleManage() {
    setError(null);
    setIsOpeningPortal(true);
    try {
      const { url } = await createPortalSession(session?.access_token);
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

  // Apple-billed subscribers: there's no Stripe customer/portal to open
  // for them at all (billingSource === 'apple_revenuecat' means
  // household.stripe_customer_id is null) — the only place to manage or
  // cancel is Apple's own subscriptions screen.
  async function handleManageIOS() {
    setError(null);
    try {
      await Linking.openURL(APPLE_MANAGE_SUBSCRIPTIONS_URL);
    } catch {
      setError("We couldn't open Apple's subscription settings. You can also manage this from Settings → your name → Subscriptions.");
    }
  }

  // Required by App Review for any IAP app: lets a customer who
  // reinstalled, or is on a new device, recover an Apple purchase they
  // already made without paying twice. Never trusted as an entitlement
  // grant itself — it only re-syncs RevenueCat's own record with Apple,
  // then the real entitlement state still comes from our own dashboard
  // fetch (RevenueCat's webhook to the backend), same as a fresh
  // purchase.
  async function handleRestore() {
    setError(null);
    setRestoreMessage(null);
    setIsRestoring(true);
    try {
      const customerInfo = await restoreApplePurchases();
      if (!isEntitled(customerInfo)) {
        setRestoreMessage("No active Home Call Guard purchase was found on this Apple ID.");
        return;
      }
      const result = await fetchDashboard(session?.access_token);
      setData(result);
      setNotEntitled(false);
      setRestoreMessage("Your subscription has been restored.");
    } catch {
      setError("We couldn't restore purchases right now. Please try again.");
    } finally {
      setIsRestoring(false);
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
          {Platform.OS === "ios" && (
            <View style={styles.restoreLink}>
              <PrimaryButton
                label="Restore purchases"
                variant="secondary"
                onPress={handleRestore}
                loading={isRestoring}
              />
              {restoreMessage && <Text style={styles.restoreMessage}>{restoreMessage}</Text>}
            </View>
          )}
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
      {restoreMessage && <Banner variant="notice" message={restoreMessage} />}

      {membership.billingSource === "apple_revenuecat" ? (
        <PrimaryButton label="Manage subscription" onPress={handleManageIOS} />
      ) : (
        membership.manageable && (
          <PrimaryButton label="Manage membership" onPress={handleManage} loading={isOpeningPortal} />
        )
      )}

      {Platform.OS === "ios" && (
        <View style={styles.restoreLink}>
          <PrimaryButton
            label="Restore purchases"
            variant="secondary"
            onPress={handleRestore}
            loading={isRestoring}
          />
        </View>
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
  restoreLink: {
    marginTop: spacing.md,
    alignSelf: "stretch",
  },
  restoreMessage: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: "center",
    marginTop: spacing.sm,
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
