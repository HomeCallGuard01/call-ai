import { Stack } from "expo-router";
import { colors } from "../../../lib/theme";

export default function AccountLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="index" options={{ title: "Account" }} />
      <Stack.Screen name="membership" options={{ title: "Membership" }} />
      <Stack.Screen name="support" options={{ title: "Support" }} />
      <Stack.Screen name="legal" options={{ title: "Legal" }} />
      <Stack.Screen name="turn-off-protection" options={{ title: "Turn Off Protection" }} />
      <Stack.Screen name="set-up-call-forwarding" options={{ title: "Set Up Call Forwarding" }} />
    </Stack>
  );
}
