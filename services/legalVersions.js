// Single source of truth for which Terms & Conditions / Privacy Policy
// version a customer is agreeing to. Bump these by hand whenever
// public/terms.html or public/privacy.html materially changes (a change
// that affects what the customer is agreeing to — pricing, cancellation,
// data handling — not a typo fix). Recorded verbatim into
// terms_acceptances (migration 029) at the moment of acceptance, so a
// later version bump never rewrites what an earlier customer actually
// agreed to.
const TERMS_VERSION = "2026-09-13";
const PRIVACY_VERSION = "2026-09-13";

module.exports = { TERMS_VERSION, PRIVACY_VERSION };
