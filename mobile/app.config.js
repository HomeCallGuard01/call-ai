module.exports = {
  expo: {
    name: "Home Call Guard",
    slug: "home-call-guard",
    scheme: "homecallguard",
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "light",
    // Root/window background — what shows behind React while the JS bundle
    // loads, i.e. the moment between the native splash hiding and the first
    // painted frame. Without this, Android's AppTheme (DayNight, no
    // windowBackground) falls back to the theme's default light background
    // and flashes white right after the splash. Same value as
    // lib/theme.ts's colors.background AND the splash backgroundColor below,
    // so splash -> window -> first screen is one continuous colour.
    backgroundColor: "#050a07",
    ios: {
      supportsTablet: false,
      bundleIdentifier: "co.uk.homecallguard.app",
      infoPlist: {
        NSMicrophoneUsageDescription:
          "Home Call Guard needs microphone access so an approved call can connect with two-way audio, the same as any normal phone call.",
        UIBackgroundModes: ["audio", "voip"],
        ITSAppUsesNonExemptEncryption: false,
      },
      entitlements: {
        // Twilio's iOS Voice Push Credential is now production-mode
        // (HomeCallGuard-iOS-VoIP-Production-2026-08-23, CR543d63fd2c9e72b0a6e7bb91aa0566c2,
        // certificate-based, matching the real VoIP Services cert/key pair) —
        // every build profile here (Ad Hoc or App Store) is production-signed,
        // so a single unconditional "production" entitlement is now correct
        // everywhere. The earlier sandbox-credential experiment (dev-profile
        // conditional) is obsolete now that a real production credential exists.
        "aps-environment": "production",
      },
    },
    android: {
      package: "co.uk.homecallguard.app",
      adaptiveIcon: {
        // Same near-black as the splash, the app's first screen and the
        // launcher icon background image — the shield now sits on the app's
        // own black/green palette instead of the old navy (#0b1220).
        backgroundColor: "#050a07",
        foregroundImage: "./assets/android-icon-foreground.png",
        backgroundImage: "./assets/android-icon-background.png",
        monochromeImage: "./assets/android-icon-monochrome.png",
      },
      predictiveBackGestureEnabled: false,
      // On EAS Build, the GOOGLE_SERVICES_JSON file-type secret env var resolves
      // to a local path to the downloaded file. Locally (expo start/prebuild),
      // that var is unset, so it falls back to the gitignored local file.
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json",
      permissions: ["android.permission.READ_CONTACTS"],
      // WRITE_CONTACTS is added unconditionally by the expo-contacts plugin
      // (it has no opt-out), and SYSTEM_ALERT_WINDOW is part of Expo's own
      // default base manifest template. HCG only reads contacts — never
      // writes to the device address book — and never draws overlays, so
      // both are unused and blocked here.
      blockedPermissions: [
        "android.permission.WRITE_CONTACTS",
        "android.permission.SYSTEM_ALERT_WINDOW",
      ],
    },
    web: {
      favicon: "./assets/favicon.png",
    },
    plugins: [
      "expo-router",
      "expo-secure-store",
      "expo-web-browser",
      [
        "expo-splash-screen",
        {
          // assets/splash-shield.png: the genuine Home Call Guard green
          // shield/telephone mark (cropped from shield-mark-padded-master.png,
          // the same mark as the launcher icon, website and Play listing) on a
          // fully transparent 1024x1024 canvas. This REPLACES the stock Expo
          // template placeholder (assets/splash-icon.png — a grey grid with
          // concentric circles) that every build up to and including Android
          // build 6 shipped as its startup screen.
          //
          // Sizing: on Android 12+ the system draws this icon in a circle
          // whose visible diameter is 2/3 of the icon canvas, so the mark must
          // sit well inside that circle (the shield is ~50% of the canvas
          // height, comfortably inside it) — which is also why the wordmark is
          // NOT on the native splash: it would be clipped. The wordmark
          // ("Home Call Guard") appears in-app immediately after, via BrandMark.
          //
          // backgroundColor is lib/theme.ts's colors.background (the app's
          // actual first frame) and the top-level backgroundColor above, so
          // there is no colour jump when the splash hands over.
          image: "./assets/splash-shield.png",
          imageWidth: 220,
          resizeMode: "contain",
          backgroundColor: "#050a07",
        },
      ],
      [
        "expo-contacts",
        {
          contactsPermission:
            "Home Call Guard uses your contacts so you can choose trusted callers. Only the contacts you choose to add are saved to Home Call Guard.",
        },
      ],
    ],
    extra: {
      router: {},
      eas: {
        projectId: "ef830297-a578-405e-b762-16f68e3097ba",
      },
    },
    owner: "homecallguard",
  },
};
