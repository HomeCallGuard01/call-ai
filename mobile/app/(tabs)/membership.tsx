// D1 — Membership (top-level tab since 1.0.2; previously Account ->
// Membership). Per APP_VISUAL_SPECIFICATION.md: real, server-derived status
// only — never a client-guessed one. "Manage membership" hands off to
// Stripe's Billing Portal in an in-app browser, kept deliberately thin
// rather than natively rebuilt (Stripe's hosted UI is already well-designed
// and well-tested).
//
// 1.0.2 (2026-10-04): status wording comes from lib/protectionView.ts's
// describeMembership ("Active", "Cancelled — protection continues until
// [date]", "Payment needs attention", "Protection unavailable"), and the
// permanent HCG account number is shown as the customer's support
// reference. The price line is still the server's membership.priceLabel
// (services/subscriptionPricing.js) — the household's own Stripe price, or
// Apple-billed wording — so this screen can never show an amount that
// differs from what the customer is actually charged. No amount is written
// here (tests/subscription-price-display.test.mjs asserts it).
import { useCallback, useState } from "react";
import { Text, View, StyleSheet, ActivityIndicator, Linking, Platform } from "react-native";
import { router, useFocusEffect } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { Card } from "../../components/Card";
import { fetchDashboard, createPortalSession, ApiError, NotEntitledError } from "../../lib/api";
import { restorePurchases as restoreApplePurchases, isEntitled } from "../../lib/purchases";
import { useAuth } from "../../lib/AuthContext";
import { describeMembership, displayAccountNumber } from "../../lib/protectionView";
import type { DashboardResponse } from "../../lib/types";
import { colors, spacing, typography } from "../../lib/theme";

// Apple's own "manage subscriptions" deep link — the only place an
// Apple-billed subscription can actually be changed/cancelled from;
// Stripe's Billing Portal has no concept of it. Documented, stable
// Apple URL scheme, not an undocumented trick.
const APPLE_MANAGE_SUBSCRIPTIONS_URL = "itms-apps://apps.apple.com/account/subscriptions";

const formatDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

export default function Membership() {
  const { session } = useAuth();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notEntitled, setNotEntitled] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadFailed(false);
    fetchDashboard(session?.access_token)
      .then(result => {
        setData(result);
        setNotEntitled(false);
      })
      .catch(err => {
        if (err instanceof NotEntitledError) setNotEntitled(true);
        else setLoadFailed(true);
      });
  }, [session?.access_token]);

  useFocusEffect(load);

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

  async function handleManageIOS() {
    setError(null);
    try {
      await Linking.openURL(APPLE_MANAGE_SUBSCRIPTIONS_URL);
    } catch {
      setError("We couldn't open Apple's subscription settings. You can also manage this from Settings → your name → Subscriptions.");
    }
  }

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

  const restoreButton = Platform.OS === "ios" && (
    <View style={styles.restoreLink}>
      <PrimaryButton label="Restore purchases" variant="secondary" onPress={handleRestore} loading={isRestoring} />
    </View>
  );

  if (notEntitled) {
    const none = describeMembership(null, formatDate);
    return (
      <Screen>
        <Text style={styles.title} accessibilityRole="header">Membership</Text>
        <Card style={styles.planCard}>
          <Text style={styles.statusNeutral}>{none.label}</Text>
          {none.detail && <Text style={styles.detail}>{none.detail}</Text>}
        </Card>
        <PrimaryButton label="Start protection" onPress={() => router.push("/(setup)/welcome")} />
        {restoreButton}
        {restoreMessage && <Text style={styles.restoreMessage}>{restoreMessage}</Text>}
        {error && <Banner variant="error" message={error} />}
      </Screen>
    );
  }

  if (loadFailed && !data) {
    return (
      <Screen>
        <Text style={styles.title} accessibilityRole="header">Membership</Text>
        <Banner variant="notice" message="We couldn't load your membership right now. Check your connection and try again." />
        <PrimaryButton label="Try again" onPress={load} />
      </Screen>
    );
  }

  if (!data) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} size="large" accessibilityLabel="Loading your membership" />
        </View>
      </Screen>
    );
  }

  const { membership } = data;
  const allowanceMembership = data.customerAllowance?.membership;
  const view = describeMembership(
    {
      status: membership.status,
      accessUntil: membership.accessUntil,
      trialEndDate: membership.trialEndDate,
      complimentary: allowanceMembership?.state === "complimentary",
      testPurchase: allowanceMembership?.testPurchase === true,
    },
    formatDate
  );
  const accountNumber = displayAccountNumber(data.account?.accountNumber);
  const statusStyle = view.tone === "good" ? styles.statusGood : view.tone === "warning" ? styles.statusWarning : styles.statusNeutral;

  return (
    <Screen>
      <Text style={styles.title} accessibilityRole="header">Membership</Text>
      <Card tone={view.tone === "good" ? "positive" : "default"} style={styles.planCard}>
        <Text style={styles.plan}>{membership.planName}</Text>
        <Text style={styles.price}>{membership.priceLabel}</Text>
        <Text style={statusStyle} accessibilityLabel={`Membership status: ${view.label}`}>{view.label}</Text>
        {view.detail && <Text style={styles.detail}>{view.detail}</Text>}
        {membership.status !== "cancelled" && membership.nextBillingDate && (
          <Text style={styles.detail}>Next payment: {formatDate(membership.nextBillingDate)}</Text>
        )}
      </Card>

      {accountNumber && (
        <Card style={styles.planCard}>
          <Text style={styles.accountLabel}>Your HCG account</Text>
          <Text style={styles.accountNumber} selectable accessibilityLabel={`HCG account ${accountNumber.split("").join(" ")}`}>
            {accountNumber}
          </Text>
          <Text style={styles.accountHint}>Quote this if you contact us — it never changes.</Text>
        </Card>
      )}

      {error && <Banner variant="error" message={error} />}
      {restoreMessage && <Banner variant="notice" message={restoreMessage} />}

      {membership.billingSource === "apple_revenuecat" ? (
        <PrimaryButton label="Manage subscription" onPress={handleManageIOS} />
      ) : (
        membership.manageable && (
          <PrimaryButton
            label={membership.status === "payment_issue" ? "Update payment details" : "Manage membership"}
            onPress={handleManage}
            loading={isOpeningPortal}
          />
        )
      )}

      {restoreButton}
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
  title: {
    ...typography.hero,
    color: colors.text,
    marginBottom: spacing.md,
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
  planCard: {
    marginBottom: spacing.md,
  },
  plan: {
    ...typography.title,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  price: {
    ...typography.body,
    color: colors.textMuted,
    marginBottom: spacing.md,
  },
  statusGood: {
    ...typography.title,
    color: colors.accent,
    marginBottom: spacing.sm,
  },
  statusWarning: {
    ...typography.title,
    color: colors.danger,
    marginBottom: spacing.sm,
  },
  statusNeutral: {
    ...typography.title,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  detail: {
    ...typography.body,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  accountLabel: {
    ...typography.eyebrow,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  accountNumber: {
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: 1,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  accountHint: {
    ...typography.caption,
    color: colors.textMuted,
  },
});
