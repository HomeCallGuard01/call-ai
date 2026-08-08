// Pure mapping from the backend's registration/resend status (see
// services/registrationRequest.js) to what the app should show — no
// network, no navigation, directly unit-testable. Deliberately reuses
// the exact wording shipped on web (public/register.html,
// public/login.html) so neither client reveals more than the other
// about whether an account exists, and a customer switching between web
// and the app sees consistent, familiar copy.
export type RegisterStatus = "pending_confirmation" | "already_registered";

export interface OutcomeContent {
  title: string;
  // Paragraphs, in order — kept as an array rather than a single string
  // with embedded newlines so the screen can render each as its own
  // <Text>, matching how the rest of this app's screens lay out body copy.
  paragraphs: string[];
}

// Shown after ANY registration attempt (new signup or resend to an
// existing unconfirmed email — deliberately identical, the anti-
// enumeration design already shipped on web, commit 51350cd) as well as
// after an already-registered account's resend outcome switches back to
// this same status. The customer is never just told to "wait" — every
// path off this screen (Sign in / Forgotten password? / Resend) is
// visible immediately, so nobody is left on it indefinitely.
const PENDING_CONFIRMATION_CONTENT: OutcomeContent = {
  title: "Check your email to finish creating your account",
  paragraphs: [
    "If this is a new account, we've sent you a confirmation email.",
    "If you already have a Home Call Guard account, sign in with your existing password or reset it if you've forgotten it.",
  ],
};

// Shown for an existing, CONFIRMED account — the one outcome where
// nothing was, or ever will be, sent. Never claims otherwise. The body
// is deliberately more direct than the hedged title ("may already be")
// about one specific fact: whatever password was just typed was not
// applied to that account — this is always true whenever this screen is
// shown, since an already-confirmed account is never touched.
const ALREADY_REGISTERED_CONTENT: OutcomeContent = {
  title: "You may already have an account — sign in or reset your password",
  paragraphs: [
    "Try signing in with your existing password. The password you just entered has not replaced your existing password.",
  ],
};

export function outcomeContent(status: RegisterStatus): OutcomeContent {
  return status === "already_registered" ? ALREADY_REGISTERED_CONTENT : PENDING_CONFIRMATION_CONTENT;
}

export type ResendStatus = "resent" | "already_registered" | "no_action";

export type ResendEffect =
  // The screen switches entirely to the already-registered content —
  // matches web's behaviour of showing the dedicated panel there too,
  // rather than a banner bolted onto the pending-confirmation screen.
  | { kind: "switch_to_already_registered" }
  // Covers BOTH "resent" (a real resend succeeded) and "no_action"
  // (nothing was sent — no pending registration exists for this email at
  // all) with the identical, deliberately hedged notice — see
  // planResendEffect below for why that's honest in both cases.
  | { kind: "show_notice"; message: string };

export function planResendEffect(status: ResendStatus): ResendEffect {
  if (status === "already_registered") {
    return { kind: "switch_to_already_registered" };
  }
  // "resent" and "no_action" intentionally share the same conditional,
  // hedged wording — see public/register.html's identical resentNotice
  // text. It's honest in both cases: true when a real resend happened,
  // vacuously true (the "if" never applies) when nothing did.
  return {
    kind: "show_notice",
    message: "If that email is registered and unconfirmed, a new confirmation email has been sent.",
  };
}
