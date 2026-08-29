# APP_DECISION_004 — Trusted Contact Management

STATUS: Proposed for review. Not implemented.

## Goal

Replace CSV/VCF upload entirely with the native flow: **tap → select trusted contacts → upload securely → done.** This is achievable natively on both platforms today, unlike the activation-code problem in APP_DECISION_003 — contact access is a normal, well-supported permission model on both iOS and Android, not a restricted telephony capability.

## Recommended implementation

- **Expo Contacts module** (`expo-contacts`) for a single cross-platform API surface — it wraps both Apple's Contacts framework and Android's `ContactsContract` provider behind one JS API, avoiding two separate native integrations for what is, from the user's perspective, one feature.
- **Multi-select UI built in-app**, not the OS's native contact-picker screen. iOS's native `CNContactPickerViewController` and Android's contact-picker intent are both single-selection-oriented in their default UI (multi-select support is inconsistent and OS-version-dependent) — a custom in-app list (read via the permission, rendered with your own multi-select UI) gives a more consistent, on-brand experience across both platforms and sidesteps that inconsistency entirely.
- **Request the minimum permission** — read-only contact access, name + phone numbers only. Never request write access; the app never needs to modify the customer's own address book.

## Privacy implications and recommendation

- **Never upload the customer's full address book.** Only the specific contacts the customer selects should ever leave the device. This is both a genuine privacy good practice and the more reassuring story for the target audience ("we only see who you tell us to trust," not "we scanned your whole phone").
- **Send selections as plain JSON** (name + normalised phone number per contact) to a new or adapted endpoint — the existing `POST /upload-contacts` is multipart-form/multer-based (built for file uploads), which is the wrong transport for a native selection payload. The existing duplicate-prevention and UK-number-normalisation *logic* (`database/contacts.js`, `normaliseNumber()`) is directly reusable; only the transport needs a mobile-appropriate JSON variant (see APP_DECISION_005).
- **No contact data should be retained anywhere longer than needed to make the API call** — don't cache the full read-out of the device address book in app state/storage beyond the current session's selection screen.
- iOS contact-access permission prompts are a one-time OS dialog with no granular "read but don't retain" enforcement beyond what the app itself does — the privacy story here rests on the app's own implementation discipline (point above), not a platform guarantee, and should be stated as such in the privacy policy update this feature will need.

## What doesn't change

`database/contacts.js`'s CRUD functions, the duplicate-prevention logic, and the UK number-normalisation function are all reused as-is — this is purely a client-side and transport-layer change, not a data-model change.
