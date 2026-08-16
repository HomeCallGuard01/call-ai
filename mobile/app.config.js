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
      supportsTablet: true,
      bundleIdentifier: "co.uk.homecallguard.app",
      infoPlist: {
        NSMicrophoneUsageDescription:
          "Home Call Guard needs microphone access so an approved call can connect with two-way audio, the same as any normal phone call.",
        UIBackgroundModes: ["audio", "voip"],
      },
      entitlements: {
        "aps-environment": "development",
      },
    },
    android: {
      package: "co.uk.homecallguard.app",
      adaptiveIcon: {
        backgroundColor: "#E6F4FE",
        foregroundImage: "./assets/android-icon-foreground.png",
        backgroundImage: "./assets/android-icon-background.png",
        monochromeImage: "./assets/android-icon-monochrome.png",
      },
      predictiveBackGestureEnabled: false,
      // On EAS Build, the GOOGLE_SERVICES_JSON file-type secret env var resolves
      // to a local path to the downloaded file. Locally (expo start/prebuild),
      // that var is unset, so it falls back to the gitignored local file.
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json",
      permissions: ["android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS"],
    },
    web: {
      favicon: "./assets/favicon.png",
    },
    plugins: [
      "expo-router",
      "expo-secure-store",
      "expo-web-browser",
      [
        "expo-contacts",
        {
          contactsPermission:
            "Home Call Guard only reads the specific contact you choose to add as a trusted contact — never your full address book.",
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
