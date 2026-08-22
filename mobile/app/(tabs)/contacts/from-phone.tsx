// "Sync contacts" (2026-08-2X rewrite) — replaces the earlier tick-list
// screen (customer manually selected each person, one at a time) with a
// single one-tap bulk sync: every contact the OS has authorised Home
// Call Guard to see is imported and saved as a trusted contact in one
// request, via POST /api/v1/contacts/sync (routes/mobileApi.js). No
// hundreds of individual addContact() calls — the backend does the
// dedup, this screen just shows progress and the result.
//
// Re-running sync is always safe: the backend skips any number already
// known, so nothing is ever duplicated. Sync only ever adds — a contact
// that's since vanished from the phone, or whose name changed there, is
// deliberately left exactly as it is in Home Call Guard (V1 does not
// sync removals or name changes; see
// docs/mobile-app/CLAUDE_SESSION_HANDOVER.md).
//
// Privacy, concretely, not just as a claim: the device contact list this
// screen reads is only ever used to build the sync request itself — it
// is never rendered or held beyond that. Only name + phone number is
// sent, never any other address-book field.
//
// On iOS 14+, Contacts.requestPermissionsAsync() may itself offer the
// customer "Limited Access" (Apple's own contact-selection UI, outside
// this app's control) instead of full access — confirmed directly
// against the installed expo-contacts type definitions
// (ContactsPermissionResponse.accessPrivileges: 'all' | 'limited' |
// 'none'). Real customer test (2026-08-2X): syncing under Limited Access
// silently imported only the handful of already-selected contacts and
// reported a misleadingly generic "synced" message, with no indication
// the rest of the address book was never seen at all. Limited Access now
// stops before syncing (the "limited" screen state below) instead of
// silently proceeding — there is no in-app API on any iOS version that
// upgrades Limited to Full Access; Settings is Apple's only route
// (confirmed against expo-contacts' own docs: presentAccessPickerAsync()
// only changes which contacts are in the Limited set, it cannot grant
// Full Access). Android's contacts permission is strictly all-or-nothing
// (no OS concept of "limited" there), so isLimited simply never becomes
// true on Android, and this entire flow is structurally inert there.
import { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Linking, AppState } from "react-native";
import { router } from "expo-router";
import * as Contacts from "expo-contacts";
import { Screen } from "../../../components/Screen";
import { PrimaryButton } from "../../../components/PrimaryButton";
import { Banner } from "../../../components/Banner";
import { BackLink } from "../../../components/BackLink";
import { syncContacts } from "../../../lib/api";
import { buildSelectableContacts } from "../../../lib/contactSelection";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../../lib/theme";

type ScreenState = "intro" | "syncing" | "denied" | "limited" | "result";

export default function AddFromPhoneContacts() {
  const [screenState, setScreenState] = useState<ScreenState>("intro");
  const [error, setError] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  // iOS 14+ only ("Limited Access") — the customer granted access to some,
  // not all, of their contacts. getContactsAsync() can only ever return
  // that limited set (see the file header comment). Always 'all' or
  // 'none' on Android; this simply never becomes true there.
  const [isLimited, setIsLimited] = useState(false);

  // Set the moment Settings is opened, so the AppState listener below
  // knows a return-to-foreground is actually "back from Settings", not
  // just an unrelated app switch — same pattern as
  // app/(setup)/activate.tsx's dialerOpened.
  const settingsOpened = useRef(false);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", nextState => {
      if (nextState === "active" && settingsOpened.current) {
        settingsOpened.current = false;
        recheckAfterSettings();
      }
    });
    return () => subscription.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reads the device address book and sends it to the bulk sync endpoint.
  // Assumes permission has already been confirmed granted by the caller —
  // never requests permission itself.
  async function loadAndSync() {
    try {
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers],
        sort: Contacts.SortTypes.FirstName,
      });
      const selectable = buildSelectableContacts(data);
      const result = await syncContacts(selectable.map(c => ({ name: c.name, number: c.number })));
      setResultMessage(result.message);
      setScreenState("result");
    } catch {
      setError("We couldn't sync your contacts just now. Please try again, or enter the contact manually.");
      setScreenState("intro");
    }
  }

  // Point-of-use only — never requested at app launch, never before the
  // customer has both seen the explanation above and actively tapped to
  // continue. Limited Access stops here — see the "limited" screen state
  // below — rather than silently syncing only the already-selected subset.
  async function requestAndSync() {
    setError(null);
    setScreenState("syncing");

    let permission: Contacts.ContactsPermissionResponse;
    try {
      permission = await Contacts.requestPermissionsAsync();
    } catch {
      setError("We couldn't open your contacts. Please try again, or enter the contact manually.");
      setScreenState("intro");
      return;
    }

    if (permission.status !== "granted") {
      setScreenState("denied");
      return;
    }

    const limited = permission.accessPrivileges === "limited";
    setIsLimited(limited);

    if (limited) {
      setScreenState("limited");
      return;
    }

    await loadAndSync();
  }

  // Primary action on the "limited" screen — Settings is Apple's only
  // supported route from Limited to Full Access (see file header comment
  // for why there is no in-app API for this on any iOS version).
  function handleOpenSettings() {
    settingsOpened.current = true;
    Linking.openSettings();
  }

  // Fires when the app returns to the foreground after handleOpenSettings
  // specifically (never for an unrelated backgrounding). If the customer
  // switched to Full Access, proceed straight to a normal full sync with
  // no extra tap; if still Limited (they left it as-is, or just looked),
  // stay on the same clear explanation rather than guessing.
  async function recheckAfterSettings() {
    setError(null);
    try {
      const permission = await Contacts.getPermissionsAsync();
      if (permission.status !== "granted") {
        setScreenState("denied");
        return;
      }
      const stillLimited = permission.accessPrivileges === "limited";
      setIsLimited(stillLimited);
      if (stillLimited) {
        setScreenState("limited");
      } else {
        setScreenState("syncing");
        await loadAndSync();
      }
    } catch {
      setScreenState("limited");
    }
  }

  // Secondary action — presentAccessPickerAsync() re-presents Apple's own
  // contact-selection UI (iOS 18+ only; rejects immediately on older iOS
  // and on Android, per expo-contacts' docs) so the customer can add
  // specific individuals to the Limited set without leaving the app. This
  // can never grant Full Access (that's Settings-only, see above) — it
  // only changes which contacts are shared, so syncing immediately
  // afterwards is the sensible next step: the customer just finished
  // choosing exactly who to include.
  async function handleChooseMoreIndividually() {
    try {
      await Contacts.presentAccessPickerAsync();
    } catch {
      // iOS below 18, or non-iOS — no in-app picker available here.
      // Stay on the "limited" screen; Settings remains the only route.
      return;
    }

    setError(null);
    setScreenState("syncing");
    try {
      const permission = await Contacts.getPermissionsAsync();
      setIsLimited(permission.accessPrivileges === "limited");
    } catch {
      // Non-fatal — proceed to sync with whatever isLimited was already.
    }
    await loadAndSync();
  }

  // Tertiary action — an explicit, deliberate choice to proceed with
  // exactly what's already shared, no OS interaction at all. This is the
  // one path a customer who genuinely prefers Limited Access takes.
  async function handleContinueWithSelected() {
    setError(null);
    setScreenState("syncing");
    await loadAndSync();
  }

  function handleDone() {
    router.back();
    router.back(); // also skip past the choice screen, back to the list
  }

  if (screenState === "intro" || screenState === "syncing") {
    return (
      <Screen scroll={false}>
        <View style={styles.container}>
          <BackLink />
          <Text style={styles.title}>Sync your contacts</Text>
          <Text style={styles.subtitle}>
            Home Call Guard imports the contacts your phone allows it to see and saves them as trusted
            contacts — their calls will always ring straight through, never screened. You can sync again any
            time to pick up new contacts; nothing is ever duplicated, and nothing is removed just because it's
            no longer on your phone.
          </Text>

          {error && <Banner variant="error" message={error} />}

          {screenState === "syncing" ? (
            <ActivityIndicator color={colors.accent} size="large" style={styles.loadingSpinner} />
          ) : (
            <PrimaryButton label="Sync contacts" onPress={requestAndSync} />
          )}

          <Pressable
            onPress={() => router.replace("/(tabs)/contacts/add")}
            accessibilityRole="button"
            style={styles.manualLink}
          >
            <Text style={styles.manualLinkText}>Enter a contact manually instead</Text>
          </Pressable>
        </View>
      </Screen>
    );
  }

  if (screenState === "denied") {
    return (
      <Screen scroll={false}>
        <View style={styles.container}>
          <BackLink />
          <Text style={styles.title}>Sync your contacts</Text>
          <Banner
            variant="error"
            message="Home Call Guard needs permission to open your contacts. You can still add contacts manually."
          />
          <PrimaryButton label="Enter a contact manually" onPress={() => router.replace("/(tabs)/contacts/add")} />
        </View>
      </Screen>
    );
  }

  if (screenState === "limited") {
    return (
      <Screen scroll={false}>
        <View style={styles.container}>
          <BackLink />
          <Text style={styles.title}>Full access needed to sync everyone</Text>
          <Text style={styles.subtitle}>
            Home Call Guard currently only has access to the contacts you've already selected on this
            iPhone — not your whole address book. Allow full access to sync everyone, or continue with
            just what's already shared.
          </Text>

          {error && <Banner variant="error" message={error} />}

          <PrimaryButton label="Allow full contact access" onPress={handleOpenSettings} />

          <Pressable onPress={handleChooseMoreIndividually} accessibilityRole="button" style={styles.limitedAccessLink}>
            <Text style={styles.limitedAccessLinkText}>Choose more contacts individually</Text>
          </Pressable>

          <Pressable onPress={handleContinueWithSelected} accessibilityRole="button" style={styles.limitedAccessLink}>
            <Text style={styles.limitedAccessLinkText}>Continue with just my selected contacts</Text>
          </Pressable>

          <Pressable
            onPress={() => router.replace("/(tabs)/contacts/add")}
            accessibilityRole="button"
            style={styles.manualLink}
          >
            <Text style={styles.manualLinkText}>Enter a contact manually instead</Text>
          </Pressable>
        </View>
      </Screen>
    );
  }

  // screenState === "result"
  return (
    <Screen scroll={false}>
      <View style={styles.container}>
        <BackLink />
        <Text style={styles.title}>Sync your contacts</Text>
        <Text style={styles.resultMessage}>{resultMessage}</Text>

        {isLimited && (
          <Pressable onPress={handleChooseMoreIndividually} accessibilityRole="button" style={styles.limitedAccessLink}>
            <Text style={styles.limitedAccessLinkText}>
              Only some contacts are shared with Home Call Guard — tap to add more from your phone
            </Text>
          </Pressable>
        )}

        {error && <Banner variant="error" message={error} />}

        <View style={styles.footer}>
          <PrimaryButton label="Done" onPress={handleDone} />
          <Pressable
            onPress={() => router.replace("/(tabs)/contacts/add")}
            accessibilityRole="button"
            style={styles.manualLink}
          >
            <Text style={styles.manualLinkText}>Enter a contact manually instead</Text>
          </Pressable>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
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
  loadingSpinner: {
    marginTop: spacing.lg,
  },
  manualLink: {
    minHeight: MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.md,
  },
  manualLinkText: {
    color: colors.accent,
    fontWeight: "600",
  },
  limitedAccessLink: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  limitedAccessLinkText: {
    color: colors.accent,
    fontWeight: "600",
    fontSize: 14,
  },
  resultMessage: {
    ...typography.body,
    color: colors.text,
    fontWeight: "600",
    marginBottom: spacing.lg,
  },
  footer: {
    paddingTop: spacing.sm,
  },
});
