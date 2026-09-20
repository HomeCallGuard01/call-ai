// The Home Call Guard logo lockup — real shield mark (assets/shield-mark.png,
// the same mark as the website and the Play icon) beside the "Home Call
// Guard" wordmark (white + green), exactly as it appears in the approved
// marketing artwork. One shared component so the brand reads identically
// on every screen, on Android and iOS alike.
import { View, Text, Image, StyleSheet } from "react-native";
import { colors, spacing } from "../lib/theme";

type Size = "sm" | "md" | "lg";
const SIZES: Record<Size, { mark: number; text: number }> = {
  sm: { mark: 26, text: 17 },
  md: { mark: 34, text: 21 },
  lg: { mark: 48, text: 28 },
};

export function BrandMark({ size = "sm", align = "center" }: { size?: Size; align?: "center" | "left" }) {
  const s = SIZES[size];
  return (
    <View
      style={[styles.row, align === "left" && styles.left]}
      accessible
      accessibilityRole="header"
      accessibilityLabel="Home Call Guard"
    >
      <Image
        source={require("../assets/shield-mark.png")}
        style={{ width: s.mark, height: s.mark }}
        resizeMode="contain"
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
      <Text style={[styles.word, { fontSize: s.text }]} accessibilityElementsHidden importantForAccessibility="no">
        <Text style={styles.white}>Home Call </Text>
        <Text style={styles.green}>Guard</Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  left: {
    justifyContent: "flex-start",
  },
  word: {
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  white: {
    color: colors.text,
  },
  green: {
    color: colors.accent,
  },
});
