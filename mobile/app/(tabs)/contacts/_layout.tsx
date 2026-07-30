import { Stack } from "expo-router";
import { colors } from "../../../lib/theme";

export default function ContactsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="index" options={{ title: "Trusted Contacts" }} />
      <Stack.Screen name="add" options={{ title: "Add Contact", presentation: "modal" }} />
    </Stack>
  );
}
