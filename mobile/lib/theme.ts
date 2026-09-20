// Home Call Guard's visual identity — the black/green look established by
// the approved Google Play marketing artwork (2026-09-20). Values are
// sampled from that artwork and the shield asset, not invented: the
// artwork's background is a near-black with a faint green cast (#010705),
// its accent green is ~#4bf977, and assets/shield-mark.png's own green is
// ~#18dd56 — the previous mint (#00ff99) and navy (#0b1220) matched
// neither the logo nor the marketing.
//
// Every screen and shared component reads from this one file (no colour
// literals elsewhere), so the whole app re-skins from here. All export
// names that existed before (colors.background/card/border/text/
// textMuted/accent/accentMuted/danger/dangerBackground/white, spacing,
// typography, MIN_TOUCH_TARGET) are kept, so nothing that already imports
// them changes meaning — only their values, and the additions below.
//
// Semantic outcome colours mirror the app's real Activity states and
// nothing more: neutral grey = a trusted contact rang straight through,
// green = screened / no concerns, amber = high risk / call stopped or
// ended. There is deliberately no red "risk rating" scale — the app has
// no such thing.
export const colors = {
  background: "#050a07",
  card: "#0c130f",
  cardElevated: "#111c16",
  border: "#1d2b23",
  borderStrong: "#2b4136",
  text: "#f3f7f4",
  textMuted: "#98a99f",
  accent: "#3cf07a",
  accentDeep: "#18dd56",
  accentMuted: "#0a2014",
  accentSoft: "rgba(60, 240, 122, 0.14)",
  accentGlow: "rgba(60, 240, 122, 0.10)",
  onAccent: "#04100a",
  neutral: "#9aa8b6",
  neutralSoft: "rgba(154, 168, 182, 0.14)",
  danger: "#f59e0b",
  dangerBackground: "#241708",
  dangerSoft: "rgba(245, 158, 11, 0.14)",
  dangerText: "#fde68a",
  noticeText: "#bbf7d0",
  white: "#ffffff",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const radius = {
  sm: 10,
  md: 14,
  lg: 20,
  pill: 999,
};

export const typography = {
  // Reserved for the single dominant "You're protected" headline (Home
  // screen redesign, 2026-08-23) — deliberately larger than `hero`, which
  // stays as-is for every other screen's title so this remains a
  // one-off, not a general size bump.
  giant: { fontSize: 32, fontWeight: "800" as const, letterSpacing: -0.6 },
  hero: { fontSize: 28, fontWeight: "700" as const, letterSpacing: -0.4 },
  title: { fontSize: 22, fontWeight: "700" as const, letterSpacing: -0.2 },
  body: { fontSize: 16, fontWeight: "400" as const },
  caption: { fontSize: 13, fontWeight: "400" as const },
  // Small all-caps section label ("RECENT ACTIVITY") — a hierarchy aid,
  // never used for body text.
  eyebrow: { fontSize: 12, fontWeight: "700" as const, letterSpacing: 1 },
};

// Minimum touch target per platform HIG/Material guidance — applied
// consistently rather than left to per-screen judgement.
export const MIN_TOUCH_TARGET = 48;
