module.exports = {
  expo: {
    name: "Home Call Guard",
    slug: "home-call-guard",
    scheme: "homecallguard",
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "light",
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
        backgroundColor: "#0b1220",
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
          // assets/splash-icon.png is a light-coloured mark on a fully
          // transparent background (confirmed by sampling its pixels —
          // center ~(221,221,225), corners (0,0,0,0) alpha) — designed for
          // a dark backdrop, not the light backgroundColor used for the
          // Android adaptive icon below. backgroundColor here is
          // lib/theme.ts's own colors.background, the same dark background
          // already used everywhere in the app's actual UI, so the splash
          // screen matches the first real frame instead of flashing.
          image: "./assets/splash-icon.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#0b1220",
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
