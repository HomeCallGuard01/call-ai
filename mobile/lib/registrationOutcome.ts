// Pure mapping from the backend's registration/resend status (see
// services/mobileRegistration.js) to what the app should show — no
// network, no navigation, directly unit-testable. Deliberately reuses
// the exact wording already shipped and tested on the web app
// (public/register.html, public/login.html, commit 51350cd's anti-
// enumeration wording pass) rather than inventing new copy, so the two
// clients stay consistent and neither drifts into revealing more than
// the other about whether an account exists.
export type RegisterStatus = "pending_confirmation" | "already_registered";

export type RegisterOutcome =
  | { screen: "confirm-email" }
  | { screen: "login"; notice: string };

export function planRegisterOutcome(status: RegisterStatus): RegisterOutcome {
  if (status === "already_registered") {
    // Matches public/login.html's existing already_registered notice
    // exactly (state=already_registered) — hedged, never a definitive
    // claim the account exists, and doesn't confirm confirmation state,
    // subscription, or household details beyond that one hedge.
    return {
      screen: "login",
      notice: "This email may already be registered. Please try signing in, or reset your password if you've forgotten it.",
    };
  }
  return { screen: "confirm-email" };
}

export type ResendStatus = "resent" | "already_registered" | "no_action";

export type ResendOutcome = {
  variant: "notice" | "error";
  message: string;
  showLoginGuidance: boolean;
};

export function planResendOutcome(status: ResendStatus): ResendOutcome {
  switch (status) {
    case "resent":
      // A real resend happened — matches public/login.html's own
      // state=resent wording exactly.
      return {
        variant: "notice",
        message: "If that email is registered and unconfirmed, a new confirmation email has been sent.",
        showLoginGuidance: false,
      };
    case "already_registered":
      // Nothing was sent — there's nothing pending to resend. Directs to
      // the existing "Already confirmed? Log in" link rather than
      // claiming a resend that never happened.
      return {
        variant: "notice",
        message: "This email is already confirmed — there's nothing to resend. Log in below, or reset your password if you're not sure.",
        showLoginGuidance: true,
      };
    case "no_action":
    default:
      // No pending registration found for this email at all. Kept
      // deliberately as neutral/non-committal as the original wording —
      // never claims success, but also doesn't reveal that no account
      // exists.
      return {
        variant: "notice",
        message: "If this email address has a pending registration, we've sent the confirmation link again.",
        showLoginGuidance: false,
      };
  }
}
