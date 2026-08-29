# APP_DECISION_007 — Risks and Recommendations

STATUS: Proposed for review. Not implemented.

## Risks

1. **Activation remains manual on both platforms.** This is the single fact most likely to disappoint if not managed proactively — it's tempting to assume "we'll build an app" implies "setup becomes automatic," and Apple's own platform restriction (APP_DECISION_003) makes that untrue regardless of engineering effort. Recommend this be explicitly, calmly communicated internally now, before app-store marketing copy gets written around an assumption the platform won't support.
2. **`whisper-1` transcription 400 error** (flagged earlier this engagement, not re-verified during this audit) — if mobile drives meaningfully more call volume, an existing latent bug gets more exposure. Recommend a real fix or at least a fresh verification before or alongside mobile launch, independent of app work itself.
3. **Push notification reliability is inherently platform-dependent** and can't be fully verified pre-launch (APNs/FCM delivery has real-world variability — battery optimisation on Android in particular can delay or drop pushes on some OEM skins). Recommend setting expectations that push is "best effort, not guaranteed" in any customer-facing copy, and that the in-app Activity screen (not push) remains the authoritative record.
4. **Contact-permission UX varies enough across real devices** that simulator testing alone won't catch everything — recommend real-device testing (both platforms) as a hard gate before Phase 3 is considered done, not an optional nice-to-have.
5. **The existing web dashboard (`upload.html`) will still need to keep working** for customers who never install the app — recommend treating "web dashboard bit-rot" as a real risk once engineering attention shifts to mobile, not an assumption that it'll be fine unattended.

## Recommendations (in addition to what's already in the six decisions above)

- **Fix the `upload.html`-at-repo-root structural oddity** (CODEBASE_AUDIT §12.1) before or during Phase 0 — small, low-risk, and removes one avoidable point of confusion while the backend is already being touched.
- **Namespace new endpoints under `/api/v1/`** from day one (APP_DECISION_005) — cheap now, expensive to retrofit once mobile traffic exists alongside web traffic in the same logs/metrics.
- **Do not attempt CallKit integration in v1.** It was investigated as part of this discovery (per your task 5) — CallKit provides a native incoming-call UI and can integrate with a VoIP-style architecture, but adopting it meaningfully would mean re-architecting how calls reach the customer (a genuinely different, much larger project than a companion app to the existing Twilio-forwarding model), not a mobile-app feature. Worth a dedicated future evaluation, explicitly out of scope for this roadmap.
- **Treat the activation-verification feature (APP_DECISION_003) as the differentiator**, not automation the platforms don't allow. This is where "premium, reassuring, polished" can genuinely be delivered and where competitors relying on a bare help-page are easiest to beat.

## Nothing discovered during this audit changes the fundamental direction

To be explicit, per your instruction to flag anything that would: **nothing found during this discovery pass suggests the mobile app project should not proceed, or that a different architecture is needed.** The existing backend is sound enough to build on directly; the risks above are manageable within the phased roadmap, not blockers to starting it.
