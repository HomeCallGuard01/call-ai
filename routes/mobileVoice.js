// Minimal mobile Voice SDK route surface, kept deliberately separate
// from server.js's own web routes (bearer-token auth via
// middleware/requireAuthApi.js, not the web app's cookie session).
//
// This is intentionally a small, standalone router rather than living in
// the full routes/mobileApi.js — that file only exists today in the
// not-yet-merged mobile app branch (sandbox/mobile-app-v1), which itself
// predates this branch's protection engine/live-monitoring work entirely
// (diverged at 8b12816, before 5d1e045/b9f3837/f404e53) — see
// docs/operations/HANDOVER_2026-08-15.md §18 for the full topology. This
// file is written so the one route it defines can be dropped into the
// real routes/mobileApi.js verbatim once that branch merges, without
// needing to reconcile anything else.
const express = require("express");
const { requireAuthApi } = require("../middleware/requireAuthApi");
const { requireEntitlement } = require("../middleware/requireEntitlement");
const { buildVoiceAccessToken } = require("../services/voiceAccessToken");

const router = express.Router();

router.use(express.json());

// GET /api/v1/voice/token
//
// Issues a short-lived Twilio Access Token (VoiceGrant) so the app can
// register the Voice SDK client and receive an approved call directly —
// the same-phone delivery mechanism replacing PSTN dial-back
// (docs/operations/HANDOVER_2026-08-15.md §12-18). requireEntitlement is
// deliberately applied: an unsubscribed household has no calls to
// receive this way, and issuing a live-callable identity to one would be
// pure unnecessary exposure. Fails closed (503) if the four Twilio
// credentials aren't configured, exactly like every other Twilio-backed
// route in this codebase — never a partial/malformed token.
router.get("/api/v1/voice/token", requireAuthApi, requireEntitlement, async (req, res) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKeySid = process.env.TWILIO_VOICE_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_VOICE_API_KEY_SECRET;
  const twimlAppSid = process.env.TWILIO_VOICE_TWIML_APP_SID;

  if (!accountSid || !apiKeySid || !apiKeySecret || !twimlAppSid) {
    console.error("VOICE ACCESS TOKEN ERROR: Twilio Voice SDK credentials not configured");
    return res.status(503).json({ error: "voice_not_configured" });
  }

  try {
    const { token, identity, ttlSeconds } = buildVoiceAccessToken({
      accountSid,
      apiKeySid,
      apiKeySecret,
      twimlAppSid,
      householdId: req.household.id,
    });

    res.json({ token, identity, ttlSeconds });
  } catch (err) {
    console.error("VOICE ACCESS TOKEN ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

module.exports = router;
