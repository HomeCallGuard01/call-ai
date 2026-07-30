// Reuses the existing web app's established brand palette (public/*.html,
// public/index.html's hero section) rather than inventing a new one —
// keeps the app visually consistent with the website rather than reading
// as a different product. Per the market-positioning refinement
// (docs/mobile-app/APP_VISUAL_SPECIFICATION.md), this should read as
// modern/premium/reassuring, not as a stripped-down "accessibility mode."
export const colors = {
  background: "#0b1220",
  card: "#111a2e",
  border: "#233047",
  text: "#e5eaf3",
  textMuted: "#94a3b8",
  accent: "#00ff99",
  accentMuted: "#0f2a1a",
  danger: "#f59e0b",
  dangerBackground: "#2a1a0f",
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

export const typography = {
  hero: { fontSize: 28, fontWeight: "700" as const },
  title: { fontSize: 22, fontWeight: "700" as const },
  body: { fontSize: 16, fontWeight: "400" as const },
  caption: { fontSize: 13, fontWeight: "400" as const },
};

// Minimum touch target per platform HIG/Material guidance — applied
// consistently rather than left to per-screen judgement.
export const MIN_TOUCH_TARGET = 48;
