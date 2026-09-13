// Display list for the mobile-carrier picker (device-picker.tsx). Purely
// presentational — the actual compatibility verdict for whichever key is
// chosen is always decided server-side by services/providerPolicy.js
// (POST /api/v1/onboarding/carrier-compatibility), never inferred here.
// Keep in sync with MobileCarrierKey (lib/types.ts) and the launch
// carrier matrix; a carrier missing from PROVIDER_POLICY (e.g. ASDA
// Mobile today) still works correctly here — it just always evaluates to
// "unverified" server-side via getProviderPolicy's fallback.
import type { MobileCarrierKey } from "./types";

export const MOBILE_CARRIERS: { key: MobileCarrierKey; label: string }[] = [
  { key: "ee", label: "EE" },
  { key: "o2", label: "O2" },
  { key: "vodafone", label: "Vodafone" },
  { key: "three", label: "Three" },
  { key: "giffgaff", label: "giffgaff" },
  { key: "tesco", label: "Tesco Mobile" },
  { key: "sky", label: "Sky Mobile" },
  { key: "id_mobile", label: "iD Mobile" },
  { key: "smarty", label: "SMARTY" },
  { key: "voxi", label: "VOXI" },
  { key: "lebara", label: "Lebara" },
  { key: "lyca", label: "Lyca Mobile" },
  { key: "talkmobile", label: "Talkmobile" },
  { key: "asda", label: "ASDA Mobile" },
  { key: "1pmobile", label: "1pMobile" },
  { key: "other", label: "Other / not listed" },
];
