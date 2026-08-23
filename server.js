// ENV_FILE selects exactly one environment file to load — set it to run
// against a specific environment (e.g. ENV_FILE=.env.staging), or leave it
// unset for plain default local development (loads .env as before). This
// is deliberately an either/or, never both: server.js used to always also
// load cwd's .env regardless of what was passed via `-r dotenv/config
// dotenv_config_path=...`, which is how a real backend ended up silently
// drawing its Stripe/Twilio/OpenAI config from the sandbox repo's default
// .env — including a live-prefixed Stripe key — even when it had been
// launched against a staging-only file that set none of those. See
// services/serverConfig.js's validateStagingEnv() for the boot-time
// safeguard this enables.
const ENV_FILE = process.env.ENV_FILE;
if (ENV_FILE) {
  require("dotenv").config({ path: ENV_FILE });
} else {
  require("dotenv").config();
}
// Non-secret by design — the path only, never a value from the file.
console.log(`[env] Loaded environment from: ${ENV_FILE || ".env (default, local development)"}`);

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const OpenAI = require("openai");
const fs = require("fs");
const multer = require("multer");
const cookieParser = require("cookie-parser");
const { createClient } = require("@supabase/supabase-js");
const { requireAuth, setSessionCookies, clearSessionCookies } = require("./middleware/requireAuth");
const { requireEntitlement } = require("./middleware/requireEntitlement");
const { getHouseholdByTwilioNumber } = require("./database/households");
const { getContacts, insertContacts, updateContact, deleteContact } = require("./database/contacts");
const { getActiveEntitlement, getSubscriptionByHouseholdId } = require("./database/billing");
const { getCallsToday, getRecentCalls, logCall, recordMonitoringOutcome, toClientCall } = require("./database/calls");
const { handleRegisterRequest, handleResendConfirmationRequest } = require("./services/registrationRequest");
const { ensureHouseholdAndRole } = require("./services/householdBootstrap");
const { buildUserScopedClient } = require("./services/supabaseClients");
const { DEVICE_TYPES, LANDLINE_PROVIDERS, buildActivationInstructions } = require("./services/activationInstructions");
const { wouldCreateForwardingLoop } = require("./services/phone");
const { resolveForwardingDestination } = require("./services/callRouting");
const { setHouseholdPhoneNumber } = require("./services/householdPhoneNumber");
const { attachMediaStreamServer } = require("./services/liveMonitoring/mediaStreamServer");
const { createOpenAiTranscribeClient } = require("./services/liveMonitoring/transcribeChunk");
const { twilioRestClient } = require("./services/twilioClient");
const billingRoutes = require("./routes/billing");
const adminRoutes = require("./routes/admin");
const mobileApiRoutes = require("./routes/mobileApi");
const { resolvePort, validateProductionEnv, validateStagingEnv } = require("./services/serverConfig");
const { stripe } = require("./services/stripeClient");

// Fail fast and clearly in production rather than starting in a silently
// broken or insecure state (e.g. a missing STRIPE_WEBHOOK_SECRET would
// otherwise mean every webhook is rejected with no obvious symptom until a
// customer notices their subscription never activated). Local development
// keeps the existing fail-open behavior for these same vars elsewhere in
// the codebase — this check only applies when NODE_ENV=production. Never
// logs a variable's value, only its name (see validateProductionEnv).
if (process.env.NODE_ENV === "production") {
  const problems = validateProductionEnv(process.env);
  if (problems.length > 0) {
    console.error("FATAL: invalid production configuration:");
    for (const problem of problems) {
      console.error(` - ${problem}`);
    }
    process.exit(1);
  }
}

// Same fail-fast principle, for an explicitly-selected non-production
// environment (ENV_FILE set) — catches the exact gap that let this
// backend silently draw Stripe config from the sandbox repo's default
// .env instead of its intended staging-only file. Plain default local dev
// (no ENV_FILE) is untouched by this check.
if (ENV_FILE && process.env.NODE_ENV !== "production") {
  const stagingProblems = validateStagingEnv(process.env);
  if (stagingProblems.length > 0) {
    console.error(`FATAL: invalid staging configuration (ENV_FILE=${ENV_FILE}):`);
    for (const problem of stagingProblems) {
      console.error(` - ${problem}`);
    }
    process.exit(1);
  }
}

const app = express();
const MAX_CONTACTS_FILE_BYTES = 512 * 1024; // 512KB — far more than any real household contact list needs
const MAX_CONTACTS_PER_UPLOAD = 500; // a file needing more than this is almost certainly the wrong file

const upload = multer({ dest: "uploads/", limits: { fileSize: MAX_CONTACTS_FILE_BYTES } });

// Wraps upload.single("file") so a file-too-large (or any other multer)
// error becomes the same clear JSON error shape every other /upload-contacts
// failure uses, instead of an unhandled middleware-level exception.
function uploadContactsFile(req, res, next) {
  upload.single("file")(req, res, function (err) {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "file_too_large", message: "That file is too large. Please choose a smaller contacts file." });
      }
      return res.status(400).json({ error: "upload_failed", message: "We could not import that contacts file. Please check the file and try again." });
    }
    next();
  });
}
const PORT = resolvePort(process.env);

// Single source of truth for the app's externally-reachable base URL —
// used for every auth email redirect (register/confirm, resend
// confirmation, password reset) and the canonical-host check below. The
// localhost fallback exists only for local development; in production,
// validateProductionEnv() above already refuses to boot if APP_URL is
// unset or still resolves to localhost/127.0.0.1, so this fallback is
// never actually reachable once deployed.
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// localhost and 127.0.0.1 are different origins for cookie purposes, so a
// session cookie set on one is invisible on the other — this bit Safari
// testing when a confirmation-email redirect (hardcoded to APP_URL's host)
// landed on a different host than the one used to register/log in. Canonicalize
// to APP_URL's host before anything else (including auth) runs, so the two
// aliases can never silently diverge. Only touches the two known local
// aliases — any other host (prod, tunnels) passes through untouched. Note:
// a 301 turns a redirected POST into a GET per HTTP client convention, so a
// form submitted from the non-canonical host loses its body and must be
// resubmitted — acceptable since that's the exact behavior requested here.
const APP_URL_PARSED = new URL(APP_URL);
const CANONICAL_HOST = APP_URL_PARSED.hostname;
const LOCAL_HOST_ALIASES = new Set(["localhost", "127.0.0.1"]);

app.use((req, res, next) => {
  if (LOCAL_HOST_ALIASES.has(req.hostname) && req.hostname !== CANONICAL_HOST) {
    return res.redirect(301, `${APP_URL_PARSED.protocol}//${APP_URL_PARSED.host}${req.originalUrl}`);
  }
  next();
});

app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static("public"));

// Owns its own raw-body parsing (scoped to /billing/webhook only, needed
// for Stripe signature verification) — safe to mount alongside the global
// urlencoded parser above, which already no-ops on non-form content types.
app.use(billingRoutes);
app.use(adminRoutes);
app.use(mobileApiRoutes);

const VoiceResponse = twilio.twiml.VoiceResponse;

// persistSession/autoRefreshToken disabled: this client now performs
// per-request signUp/signInWithPassword calls for different users, and it's
// a shared module-level instance — without this it would keep an in-memory
// "current session" that concurrent requests from different users could
// overwrite. Every call site below uses the session/user returned directly
// from its own call, never an ambient one, so this only removes an unused,
// unsafe side effect.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// Service-role client, used only for the `calls` table. `calls` has RLS
// enabled with no anon/authenticated policies (default-deny) — see
// supabase/migrations/001_create_calls_table.sql — so it is reachable only
// through this key. `contacts` continues to use the anon client above,
// unchanged this sprint.
//
// createClient() throws synchronously if given an undefined key, which
// would take down the whole server before it even starts listening — so
// this is only constructed when the key is actually present, and every
// calls-table helper below checks for it and fails open (same pattern as
// every other Supabase read/write in this file) rather than crashing.
const supabaseAdmin = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

if (!supabaseAdmin) {
  console.warn(
    "SUPABASE_SERVICE_ROLE_KEY is not set — call history will not be read or written until it is configured."
  );
}

// Guarded the same way supabaseAdmin above and services/stripeClient.js's
// stripe client already are: the SDK's own constructor throws synchronously
// if apiKey is undefined, which previously crashed the entire process at
// boot whenever OPENAI_API_KEY was unset — not just the AI-classification
// feature that actually needs it. The one call site (below) already
// try/catches and falls open to a "SAFE" result on any failure, so a null
// client here degrades the same way a failed API call already did.
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

if (!openai) {
  console.warn(
    "OPENAI_API_KEY is not set — scam-call AI classification will fail open to SAFE until it is configured."
  );
}

function normaliseNumber(number) {
  return (number || "").replace(/\D/g, "").slice(-10);
}

// Shared by both the known-contact bypass (/voice) and the screened-safe
// passthrough (/process) — the only two places a call is ever forwarded
// on to a real person. Never dials a hardcoded/fallback number: a
// household with no phone_number on file fails closed (a clear message,
// then hangup) rather than silently routing to the wrong destination.
function dialHouseholdOrFailClosed(twiml, household) {
  const destination = resolveForwardingDestination(household);

  if (destination.canForward) {
    const dial = twiml.dial();
    dial.number(destination.number);
    return;
  }

  console.error(
    "CALL ROUTING ERROR: no forwarding number on file for household",
    household && household.id
  );
  twiml.say(
    { voice: "Polly.Amy", language: "en-GB" },
    "We're sorry, this call cannot be connected right now. Please try again later."
  );
  twiml.hangup();
}

// Restoring progressive monitoring (2026-08-11, selectively ported from
// sandbox/v1.5-live-monitoring — see the reconciliation report for the
// full file-by-file plan). Attaches a <Start><Stream> alongside an
// already-decided connect, so a connected call is now also live-
// monitored — never changes whether or how the call connects, purely
// additive. Only ever called from /process's SAFE-connect branch for an
// unknown caller — /voice's known-contact bypass never calls this, so a
// trusted contact's call connects exactly as it always has: no
// transcription, no SMS monitoring, protecting family conversations'
// privacy and avoiding transcription cost on calls that were never in
// question.
//
// Deliberately reuses the SAME resolveForwardingDestination(household)
// this call is already being dialled through — never a second,
// independently-sourced number. That's the exact class of bug this
// integration was told not to bring back: the source branch had a
// hardcoded dial target and a separately-sourced SMS number that could
// silently disagree.
function buildMediaStreamUrl(appUrl) {
  return appUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:") + "/media-stream";
}

// Red-line termination (2026-08-15): the TwiML endpoint the live call is
// redirected to when services/liveMonitoring/callTermination.js's first
// two attempts succeed — plain http(s), not wss, since this is fetched
// by Twilio's REST API as ordinary TwiML, not a media stream.
function buildRedLineTerminateUrl(appUrl) {
  return appUrl + "/red-line-terminate";
}

function attachLiveMonitoring(twiml, { household, twilioNumber }) {
  if (!household) return;

  const destination = resolveForwardingDestination(household);

  const start = twiml.start();
  const stream = start.stream({ url: buildMediaStreamUrl(APP_URL) });
  stream.parameter({ name: "householdId", value: household.id });
  if (destination.canForward) {
    stream.parameter({ name: "toNumber", value: destination.number });
  } else {
    console.error("LIVE MONITORING: no valid destination — SMS warning will be skipped", household.id);
  }
  stream.parameter({ name: "protectedNumber", value: twilioNumber });
}

// VOICE CALL ENTRY

app.post("/voice", async (req, res) => {
  const twiml = new VoiceResponse();

  const household = await getHouseholdByTwilioNumber(req.body.To);

  if (!household) {
    console.error("CALL ROUTING ERROR: no household matches dialled number", req.body.To);
  }

  const contacts = household ? await getContacts(household.id) : [];
  const caller = req.body.From;
  const callerNorm = normaliseNumber(caller);

  const isKnown = contacts.some(
    c => c.number && normaliseNumber(c.number) === callerNorm
  );

  if (isKnown) {
    console.log("Known contact → bypass AI");

    if (household) {
      logCall({
        callSid: req.body.CallSid,
        number: caller,
        status: "Known",
        result: "SAFE",
        aiModel: null,
        processingTimeMs: 0,
        householdId: household.id,
      }).catch(err => console.error("CALL LOG FAILED:", err.message));
    } else {
      console.error("CALL LOG SKIPPED: no household matches dialled number", req.body.To);
    }

    dialHouseholdOrFailClosed(twiml, household);

    return res.type("text/xml").send(twiml.toString());
  }

  const gather = twiml.gather({
    input: "speech",
    action: "/process",
    method: "POST",
    speechTimeout: "auto",
  });

  gather.say(
    { voice: "Polly.Amy", language: "en-GB" },
    "This call is protected by Home Call Guard. Please briefly state your reason for calling."
  );

  return res.type("text/xml").send(twiml.toString());
});

// PROCESS UNKNOWN CALL

app.post("/process", async (req, res) => {
  const twiml = new VoiceResponse();
  const processingStart = Date.now();

  const speech = req.body.SpeechResult || "";
  const from = req.body.From;
  const callSid = req.body.CallSid;

  const household = await getHouseholdByTwilioNumber(req.body.To);

  if (!household) {
    console.error("CALL ROUTING ERROR: no household matches dialled number", req.body.To);
  }

  const contacts = household ? await getContacts(household.id) : [];
  const fromNorm = normaliseNumber(from);

  const isKnown = contacts.some(
    c => c.number && normaliseNumber(c.number) === fromNorm
  );

  if (!speech || speech.length < 2) {
    twiml.say("Sorry, I didn't catch that. Please try again.");
    return res.type("text/xml").send(twiml.toString());
  }

  // Legacy keyword pre-filter — removed (Decision 012, restored
  // 2026-08-11). A caller mentioning "bank", "Amazon", "BT", "Sky", etc.
  // was instantly classified SCAM before the AI classifier — or live
  // monitoring — ever ran. Confirmed live on this exact staging number
  // this week: a real "bank" call resolved in ~127ms with ai_model: null,
  // versus ~1800ms with ai_model: "gpt-4o-mini" for an ordinary call —
  // proof the classifier never ran. Every unknown caller whose speech is
  // long enough now reaches the GPT classifier unconditionally; identity
  // alone is handled by the prompt below, not by blocking on keywords.
  let isScam = false;
  let result = "SAFE";
  let aiModel = null;

  if (openai && speech.length > 5) {
    try {
      const aiResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are screening an incoming phone call for a household. " +
              "Classify the call as SCAM only when the caller is attempting or clearly preparing to obtain something high risk, such as: " +
              "passwords, PINs, one-time passcodes (OTPs), security verification codes, bank or payment card details, remote access to a device, " +
              "transferring money, moving money to a different or \"safe\" account, purchasing gift cards, or sending cryptocurrency. " +
              "Also classify as SCAM when the caller discourages the person from checking with anyone else — for example telling them to keep the call secret, not to tell family, not to contact their bank, or not to hang up. " +
              "Do not classify a call as SCAM simply because the caller claims to represent a bank, Amazon, a delivery company, a government department, the police, HMRC, or any other organisation. " +
              "Identity alone is not evidence of fraud — it is context, not guilt. " +
              "If the caller is only identifying themselves, introducing the reason for the call, or requesting a normal conversation without any high-risk request or secrecy pressure, respond SAFE. " +
              "Respond with exactly one word: SCAM or SAFE.",
          },
          {
            role: "user",
            content: speech,
          },
        ],
      });

      aiModel = "gpt-4o-mini";
      result = aiResponse.choices[0].message.content.trim();

      if (result === "SCAM") {
        isScam = true;
      }
    } catch (err) {
      console.log("AI failed:", err.message);
    }
  }

  if (household) {
    logCall({
      callSid,
      number: from,
      status: isKnown ? "Known" : "Unknown",
      result: isScam ? "SCAM" : "SAFE",
      aiModel,
      processingTimeMs: Date.now() - processingStart,
      householdId: household.id,
    }).catch(err => console.error("CALL LOG FAILED:", err.message));
  } else {
    console.error("CALL LOG SKIPPED: no household matches dialled number", req.body.To);
  }

  if (isScam) {
    twiml.say(
      { voice: "Polly.Amy", language: "en-GB" },
      "This call cannot be completed. Goodbye."
    );
    twiml.hangup();
  } else {
    // Addressed to the CALLER, not the protected customer — a real audit
    // this week found the previous wording ("Please be cautious when
    // sharing personal information") was security advice meant for the
    // household, played to whoever is calling in, including a caller who
    // passed screening but turns out to be the scammer being warned about
    // their own tactics. Neutral, gives no security advice either way.
    // The actual protected-customer warning is delivered separately and
    // privately, via SMS, by live monitoring below.
    twiml.say(
      { voice: "Polly.Amy", language: "en-GB" },
      "This call may be monitored by Home Call Guard for the safety of the person you're calling. Please continue normally."
    );

    twiml.pause({ length: 1 });

    attachLiveMonitoring(twiml, { household, twilioNumber: req.body.To });

    dialHouseholdOrFailClosed(twiml, household);
  }

  return res.type("text/xml").send(twiml.toString());
});

// RED-LINE TERMINATION
//
// Fetched by Twilio's REST API (client.calls(sid).update({url, method}))
// when services/liveMonitoring/callTermination.js's redirect attempt
// runs — never called directly by a phone, so it needs no Gather/speech
// handling of its own. Deliberately generic wording: no detail about
// which specific behaviour triggered it, so a real caller doesn't get a
// coaching signal on what to avoid saying next time.
app.post("/red-line-terminate", (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say(
    { voice: "Polly.Amy", language: "en-GB" },
    "This call has been identified as high risk and is being ended for the safety of the person you called."
  );
  twiml.hangup();
  return res.type("text/xml").send(twiml.toString());
});

// VOICE SDK TWIML APP FALLBACK
//
// The mobile app's Voice SDK client never places outgoing calls in V1
// (it only receives — see services/voiceAccessToken.js's comment on
// outgoingApplicationSid), so this should never actually be invoked by a
// real user action. It exists only because the TwiML Application
// resource backing the mobile Access Token's VoiceGrant requires a
// Voice URL to be a valid, reachable endpoint.
app.post("/voice-sdk-outbound-not-supported", (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say(
    { voice: "Polly.Amy", language: "en-GB" },
    "Outgoing calls are not supported by this application."
  );
  twiml.hangup();
  return res.type("text/xml").send(twiml.toString());
});

// Fetched once scripts/trigger-voice-sdk-test-call.js's REST-initiated
// call is answered by the Voice SDK client — proves the call actually
// connected and two-way audio is live, entirely independent of the real
// /voice -> /process screening flow. Never reachable from a real phone
// call; only ever invoked by that one manual test script.
app.post("/voice-sdk-test-call-answered", (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say(
    { voice: "Polly.Amy", language: "en-GB" },
    "Test call connected successfully. Same phone delivery is working."
  );
  return res.type("text/xml").send(twiml.toString());
});

// DASHBOARD API

app.get("/dashboard-data", requireAuth, requireEntitlement, async (req, res) => {
  const [callsToday, recentCalls, contacts, subscription] = await Promise.all([
    getCallsToday(req.household.id),
    getRecentCalls(req.household.id, 10),
    getContacts(req.household.id),
    getSubscriptionByHouseholdId(req.household.id),
  ]);

  // Membership status is always derived here, server-side, from the real
  // subscriptions/entitlements rows the Stripe webhook itself wrote — never
  // from anything client-supplied. 'trial' is checked first since
  // entitlements.entitlement_type already supports 'free_trial' (Decision
  // 009) even though nothing creates one yet; this makes the UI trial-
  // ready without a real trial-issuing flow existing.
  let membershipStatus = "active";
  if (req.entitlement.entitlement_type === "free_trial") {
    membershipStatus = "trial";
  } else if (subscription && subscription.status === "past_due") {
    // Still an active entitlement (past_due qualifies — see
    // process_stripe_webhook_event in migration 013) — protection
    // continues while Stripe retries payment; this is a status to
    // surface, not a reason to withdraw access.
    membershipStatus = "payment_issue";
  } else if (subscription && subscription.cancel_at_period_end) {
    membershipStatus = "cancelled";
  }

  res.json({
    // req.household already carries this — requireAuth's
    // getHouseholdByAuthUserId does a plain select("*"), so no extra
    // query is needed for the household's own provisioning state.
    // twilioNumber deliberately not included — never sent to the browser.
    // phoneNumberAdded follows the same rule: a boolean only, never the
    // stored value itself — enough for the dashboard to show a persistent
    // "saved" state without exposing the number.
    twilioProvisioningStatus: req.household.twilio_provisioning_status || "pending",
    phoneNumberAdded: !!req.household.phone_number,
    contactsUploaded: contacts.length,
    // Full contact list (id, so Edit/Delete can target the right row,
    // plus name + number — never household_id) for the "Trusted contacts"
    // section. Same query/data already fetched above for the count.
    contacts: contacts.map(c => ({ id: c.id, name: c.name, number: c.number })),
    callsScreened: callsToday.filter(call => call.status === "Unknown").length,
    suspectedScamsBlocked: callsToday.filter(call => call.result === "SCAM").length,
    trustedCallsRecognised: callsToday.filter(call => call.status === "Known").length,
    recentCalls: recentCalls.map(toClientCall),
    // Drives the "Open Admin Dashboard" nav button only — never the
    // actual access control. /admin remains gated server-side by
    // requireAuth + requireAdmin (middleware/requireAdmin.js) regardless
    // of what this flag says; a customer manually forging this field in
    // devtools still hits that real check and is redirected.
    isAdmin: req.role === "admin",
    // Account details section — req.household/req.entitlement are
    // already loaded in memory by requireAuth/requireEntitlement, so this
    // is free (no extra query, no new integration).
    account: {
      email: req.household.email,
      memberSince: req.household.created_at,
      entitlementType: req.entitlement.entitlement_type,
    },
    // Membership card (Stage 4). planName/priceLabel are hardcoded,
    // matching this project's existing single-price-point convention
    // (Decision 009) — not a live Stripe Price lookup. Every date/status
    // value here comes from the real subscriptions/entitlements rows the
    // webhook wrote; never invented client-side.
    membership: {
      planName: "Home Call Guard Standard",
      priceLabel: "£4.99 per month",
      status: membershipStatus,
      nextBillingDate: subscription && !subscription.cancel_at_period_end ? subscription.current_period_end : null,
      accessUntil: subscription ? subscription.current_period_end : null,
      trialEndDate: req.entitlement.entitlement_type === "free_trial" ? req.entitlement.ends_at : null,
      // False for complimentary/founding/promotional/staff access, which
      // has no real Stripe subscription behind it to manage in the portal.
      manageable: !!(req.household.stripe_customer_id && subscription),
    },
  });
});

// GET /activation-instructions?deviceType=iphone|android|landline&provider=bt|sky|virgin|talktalk|plusnet|other
//
// The web equivalent of the mobile app's GET /api/v1/activation/instructions
// (routes/mobileApi.js) — same narrow exception to "the Twilio number is
// never sent to any client", same reused services/activationInstructions.js
// so the per-provider formatting/caveats live in exactly one place. Web
// customers had no channel at all to learn their forwarding destination
// (no email, no SMS, /dashboard-data deliberately omits twilioNumber) —
// this route closes that gap for the existing web dashboard (upload.html)
// without changing /dashboard-data or introducing any new business logic.
app.get("/activation-instructions", requireAuth, requireEntitlement, (req, res) => {
  const { deviceType, provider, protectedNumber } = req.query;

  if (typeof deviceType !== "string" || !DEVICE_TYPES.has(deviceType)) {
    return res.status(400).json({
      error: "invalid_input",
      message: `deviceType must be one of: ${[...DEVICE_TYPES].join(", ")}`,
    });
  }

  if (deviceType === "landline" && (typeof provider !== "string" || !LANDLINE_PROVIDERS.has(provider))) {
    return res.status(400).json({
      error: "invalid_input",
      message: `provider is required for landline and must be one of: ${[...LANDLINE_PROVIDERS].join(", ")}`,
    });
  }

  // See routes/mobileApi.js's identical check for the full explanation —
  // protectedNumber is optional so this never breaks an existing caller
  // that doesn't send it, only blocks when the loop risk is detectable.
  if (
    typeof protectedNumber === "string" &&
    protectedNumber &&
    wouldCreateForwardingLoop(protectedNumber, req.household.phone_number)
  ) {
    return res.status(400).json({
      error: "forwarding_loop",
      message:
        "Choose a different number for safe calls to ring. If you forward this phone to Home Call Guard and we send safe calls back to the same phone, the calls will loop and your phone may not ring.",
    });
  }

  if (!req.household.twilio_number) {
    return res.status(409).json({ error: "not_provisioned" });
  }

  try {
    const instructions = buildActivationInstructions({
      twilioNumber: req.household.twilio_number,
      deviceType,
      provider,
    });

    res.json({
      code: instructions.code,
      cancelCode: instructions.cancelCode,
      requiresPreliminaryCall: instructions.requiresPreliminaryCall,
      preliminaryCallNumber: instructions.preliminaryCallNumber,
      preliminaryCallNote: instructions.preliminaryCallNote,
      explanation: "This is Home Call Guard's protection number — you'll forward your calls to it now.",
    });
  } catch (err) {
    console.error("WEB ACTIVATION INSTRUCTIONS ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

// POST /household/phone-number { number }
//
// The minimum write path for households.phone_number — the real
// destination trusted/screened-safe calls are forwarded to
// (services/callRouting.js). Added because nothing anywhere in this app
// ever collected it (found while fixing the hardcoded forwarding-number
// defect). req.household.id is resolved server-side by requireAuth, never
// client-supplied, so this can only ever write the caller's own household.
app.post("/household/phone-number", requireAuth, requireEntitlement, async (req, res) => {
  const result = await setHouseholdPhoneNumber(req.household.id, req.body.number);

  if (!result.ok) {
    return res.status(result.error === "invalid_input" ? 400 : 500).json({ error: result.error });
  }

  res.json({ ok: true, number: result.number });
});

app.get("/logs", requireAuth, requireEntitlement, async (req, res) => {
  const calls = await getRecentCalls(req.household.id, 200);
  res.json(calls.map(toClientCall));
});

// UPLOAD CONTACTS
//
// Handles three customer-facing entry points, all through this one route:
// a real CSV file, a real VCF/vCard file, and the Android Contact Picker
// path (upload.html builds a synthetic "name,number" text file client-side
// from the customer's picked contacts and uploads it here exactly like a
// real CSV) — one parsing/validation/insertion path to keep correct rather
// than three.

function parseContactsCsv(text) {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const parts = line.split(",");
      return { name: parts[0]?.trim() || "Unknown", number: normaliseNumber(parts[1]) };
    });
}

// Minimal RFC 6350-shaped parser: enough for the simple name+phone vCards
// real phones export, not a fully spec-compliant implementation (e.g. does
// not unfold long folded lines, which only matters for fields like PHOTO:
// that this app never reads anyway — those lines simply don't match FN/N/TEL
// and are harmlessly ignored).
function parseContactsVcf(text) {
  const blocks = text.split(/BEGIN:VCARD/i).slice(1);

  return blocks.map(block => {
    const lines = block.split(/\r?\n/);
    let name = null;
    let number = null;

    for (const line of lines) {
      if (!name && /^FN[:;]/i.test(line)) {
        name = line.split(":").slice(1).join(":").trim();
      } else if (!name && /^N[:;]/i.test(line)) {
        // Fallback when FN is missing: N is "Last;First;...", reassembled
        // as "First Last" for a readable name.
        const parts = (line.split(":")[1] || "").split(";");
        name = [parts[1], parts[0]].filter(Boolean).join(" ").trim();
      } else if (!number && /^TEL[:;]/i.test(line)) {
        number = line.split(":").slice(1).join(":").trim();
      }
    }

    return { name: name || "Unknown", number: normaliseNumber(number) };
  });
}

app.post("/upload-contacts", requireAuth, uploadContactsFile, async (req, res) => {
  try {
    const entitlement = await getActiveEntitlement(req.household.id);
    if (!entitlement) {
      return res.status(402).json({ error: "not_entitled", message: "An active subscription is required to upload contacts." });
    }

    if (!req.file) {
      return res.status(400).json({ error: "no_file", message: "We could not import that contacts file. Please check the file and try again." });
    }

    const filePath = req.file.path;
    const data = fs.readFileSync(filePath, "utf8");
    const isVcf = /\.(vcf|vcard)$/i.test(req.file.originalname || "");

    const rawContacts = isVcf ? parseContactsVcf(data) : parseContactsCsv(data);
    const validContacts = rawContacts.filter(c => c.number.length === 10);

    if (validContacts.length === 0) {
      return res.status(400).json({ error: "no_valid_contacts", message: "We could not import that contacts file. Please check the file and try again." });
    }

    if (validContacts.length > MAX_CONTACTS_PER_UPLOAD) {
      return res.status(400).json({ error: "too_many_contacts", message: "That file has too many contacts. Please check the file and try again." });
    }

    // Duplicate prevention, both against the household's existing contacts
    // and within the file itself — same normalised-number comparison as
    // the single-contact add/edit routes.
    const existing = await getContacts(req.household.id);
    const seen = new Set(existing.map(c => normaliseNumber(c.number)));
    const toInsert = [];
    let skippedDuplicates = 0;

    for (const c of validContacts) {
      if (seen.has(c.number)) {
        skippedDuplicates++;
        continue;
      }
      seen.add(c.number);
      toInsert.push({ name: c.name, number: c.number, customer_id: null });
    }

    const savedContacts = toInsert.length > 0 ? await insertContacts(req.household.id, toInsert) : [];

    res.json({
      added: savedContacts.length,
      skippedDuplicates,
      message: `${savedContacts.length} trusted contact${savedContacts.length === 1 ? "" : "s"} added successfully.`,
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ error: "failed", message: "We could not import that contacts file. Please check the file and try again." });
  }
});

// ADD / EDIT / DELETE ONE TRUSTED CONTACT
//
// Same ownership model as /upload-contacts above: req.household.id comes
// only from requireAuth's verified session, never from the request body,
// so a contact can never be added/edited/deleted against another
// household. updateContact/deleteContact additionally scope their query
// by household_id (not just the contact id), so a contactId belonging to
// a different household is never affected even if guessed/forged.

app.post("/contacts", requireAuth, requireEntitlement, async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const number = normaliseNumber(req.body.number);

    if (!name || number.length !== 10) {
      return res.status(400).json({ error: "invalid_input" });
    }

    const existing = await getContacts(req.household.id);
    if (existing.some(c => normaliseNumber(c.number) === number)) {
      return res.status(409).json({ error: "duplicate", message: "This number is already in your trusted contacts." });
    }

    const [saved] = await insertContacts(req.household.id, [{ name, number, customer_id: null }]);
    res.status(201).json({ id: saved.id, name: saved.name, number: saved.number });
  } catch (err) {
    console.error("ADD CONTACT ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

app.put("/contacts/:id", requireAuth, requireEntitlement, async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const number = normaliseNumber(req.body.number);

    if (!name || number.length !== 10) {
      return res.status(400).json({ error: "invalid_input" });
    }

    const existing = await getContacts(req.household.id);
    if (existing.some(c => c.id !== req.params.id && normaliseNumber(c.number) === number)) {
      return res.status(409).json({ error: "duplicate", message: "This number is already in your trusted contacts." });
    }

    const updated = await updateContact(req.household.id, req.params.id, { name, number });
    if (updated.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }
    res.json({ id: updated[0].id, name: updated[0].name, number: updated[0].number });
  } catch (err) {
    console.error("UPDATE CONTACT ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

app.delete("/contacts/:id", requireAuth, requireEntitlement, async (req, res) => {
  try {
    const deleted = await deleteContact(req.household.id, req.params.id);
    if (deleted.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE CONTACT ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

// AUTH HELPERS
//
// buildUserScopedClient is imported from services/supabaseClients.js
// (shared with routes/mobileApi.js's /api/v1/me/bootstrap, which needs
// the exact same "act as this one user under RLS" client) — see that
// module for the implementation.

// AUTH: REGISTER

app.post("/register", async (req, res) => {
  const { email, password, confirm_password } = req.body;

  if (!email || !password) {
    const q = email ? `&email=${encodeURIComponent(email)}` : "";
    return res.redirect(`/register.html?state=error&reason=validation${q}`);
  }

  if (password !== confirm_password) {
    return res.redirect(
      `/register.html?state=error&reason=mismatch&email=${encodeURIComponent(email)}`
    );
  }

  // See services/registrationFlow.js for why this check exists: calling
  // signUp() a second time for an already-existing unconfirmed email
  // silently discards the newly submitted password (documented Supabase
  // behaviour, not something this app controls) — this routes around
  // that instead of ever hitting it. Reuses the exact same decision
  // logic the mobile app's /api/v1/register route uses
  // (services/registrationRequest.js) — one set of rules, not two.
  const result = await handleRegisterRequest({
    email,
    password,
    adminClient: supabaseAdmin,
    authClient: supabase,
    emailRedirectTo: `${APP_URL}/confirmed.html`,
  });

  if (result.status === "error") {
    return res.redirect(
      `/register.html?state=error&reason=failed&email=${encodeURIComponent(email)}`
    );
  }

  if (result.status === "already_registered") {
    // Already a real, confirmed account — never attempt another signup.
    // Stays on register.html (not a redirect to login.html) so the
    // customer sees the dedicated "This email may already be
    // registered" panel there, with clear Sign in / Reset password
    // actions, rather than being silently bounced to a different page.
    return res.redirect(`/register.html?state=already_registered&email=${encodeURIComponent(email)}`);
  }

  // Email confirmation is required on this project, so signUp() does not
  // return a session here — household/role creation happens on first
  // login instead (see /login below), once a real session exists.
  if (!result.session) {
    return res.redirect(`/register.html?state=pending_confirmation&email=${encodeURIComponent(email)}`);
  }

  // Only reachable if email confirmation is ever turned off: signUp()
  // would then return a session immediately, so household/role setup can
  // happen right away instead of waiting for first login.
  try {
    const userClient = buildUserScopedClient();
    await userClient.auth.setSession({
      access_token: result.session.access_token,
      refresh_token: result.session.refresh_token,
    });
    await ensureHouseholdAndRole(userClient, result.user.id, email, "[REGISTER]");
  } catch (err) {
    console.error("REGISTER HOUSEHOLD SETUP ERROR:", err.message);
    return res.redirect(
      `/register.html?state=error&reason=failed&email=${encodeURIComponent(email)}`
    );
  }

  setSessionCookies(res, result.session);
  return res.redirect("/dashboard");
});

// AUTH: LOGIN

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.redirect("/login.html?error=validation");
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.session) {
    console.error("SUPABASE LOGIN ERROR:", error?.message);

    if (error?.message?.toLowerCase().includes("email not confirmed")) {
      return res.redirect(
        `/login.html?error=unconfirmed&email=${encodeURIComponent(email)}`
      );
    }

    return res.redirect("/login.html?error=invalid_credentials");
  }

  // Confirmed email is the point a real session first exists, so this is
  // where a first-time customer's household/role actually get created —
  // see services/householdBootstrap.js. No-op on every login after that.
  try {
    const userClient = buildUserScopedClient();
    await userClient.auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
    await ensureHouseholdAndRole(userClient, data.user.id, email, "[LOGIN]");
  } catch (err) {
    console.error("LOGIN HOUSEHOLD SETUP ERROR:", err.message);
    return res.redirect("/login.html?error=setup_failed");
  }

  console.log("[LOGIN] Redirect dashboard");
  setSessionCookies(res, data.session);
  return res.redirect("/dashboard");
});

// AUTH: RESEND CONFIRMATION
//
// Shared by two different pages, distinguished by the hidden return_to
// field each form submits — register.html's own resend button (a
// customer who just registered), and login.html's (a customer who tried
// to log in and was told to confirm their email first). Previously
// called supabase.auth.resend() unconditionally and always redirected to
// "?state=resent" regardless of whether Supabase actually sent anything —
// the same false-success shape the mobile app's equivalent bug had. Now
// reuses services/registrationRequest.js's real decision logic, so a
// "sent again" claim is only ever shown when a resend genuinely
// succeeded, and an already-confirmed account is told so directly
// instead.
app.post("/resend-confirmation", async (req, res) => {
  const { email, return_to } = req.body;
  const returnsToLogin = return_to === "login";
  const returnPage = returnsToLogin ? "/login.html" : "/register.html";

  if (!email) {
    return res.redirect(`${returnPage}?state=${returnsToLogin ? "resent" : "pending_confirmation"}`);
  }

  const result = await handleResendConfirmationRequest({
    email,
    adminClient: supabaseAdmin,
    authClient: supabase,
    emailRedirectTo: `${APP_URL}/confirmed.html`,
  });

  if (result.status === "already_registered") {
    return res.redirect(`${returnPage}?state=already_registered&email=${encodeURIComponent(email)}`);
  }

  // "resent" and "no_action" are deliberately shown identically — the
  // existing notice text ("If that email is registered and unconfirmed,
  // a new confirmation email has been sent.") is itself a conditional
  // statement, honest either way, matching this codebase's established
  // anti-enumeration wording pattern. register.html additionally flags
  // resent_attempted so it can show that same notice inline.
  if (returnsToLogin) {
    return res.redirect("/login.html?state=resent");
  }
  return res.redirect(`/register.html?state=pending_confirmation&resent_attempted=1&email=${encodeURIComponent(email)}`);
});

// AUTH: LOGOUT

app.post("/logout", (req, res) => {
  clearSessionCookies(res);
  res.redirect("/login.html");
});

// AUTH: FORGOT PASSWORD

app.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  if (email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${APP_URL}/reset-password.html`,
    });

    if (error) {
      console.error("SUPABASE RESET EMAIL ERROR:", error.message);
    }
  }

  // Same response whether or not the email is registered, to avoid
  // leaking which addresses have accounts.
  return res.redirect("/forgot-password.html?state=sent");
});

// AUTH: RESET PASSWORD COMPLETE

app.post("/reset-password-complete", async (req, res) => {
  const { access_token, refresh_token, new_password } = req.body;

  if (!access_token || !refresh_token || !new_password) {
    return res.status(400).json({ error: "invalid" });
  }

  // Fresh, per-request client: the recovery token belongs to one specific
  // user, so it must never be set on the shared `supabase` instance above.
  const resetClient = buildUserScopedClient();

  const { error: sessionError } = await resetClient.auth.setSession({
    access_token,
    refresh_token,
  });

  if (sessionError) {
    console.error("SUPABASE RESET SESSION ERROR:", sessionError.message);
    return res.status(400).json({ error: "invalid" });
  }

  const { error: updateError } = await resetClient.auth.updateUser({
    password: new_password,
  });

  if (updateError) {
    console.error("SUPABASE PASSWORD UPDATE ERROR:", updateError.message);

    if (updateError.code === "same_password") {
      return res.status(400).json({ error: "same_password" });
    }

    return res.status(500).json({ error: "failed" });
  }

  const {
    data: { session },
  } = await resetClient.auth.getSession();

  // A password reset establishes a real, valid session (setSessionCookies
  // below), but requireAuth also requires a households/user_roles row to
  // exist before it will accept that session — see requireAuth's own
  // "no household -> clearSessionCookies + redirect" branch. /login and
  // /register both call ensureHouseholdAndRole() for exactly this reason;
  // this route previously didn't, so a customer resetting their password
  // before ever completing a first login got a genuinely valid session
  // that requireAuth then destroyed on the very next request. Uses the
  // already-session-bearing resetClient (same idempotent, no-op-if-
  // already-exists behaviour as the /login and /register call sites).
  try {
    await ensureHouseholdAndRole(resetClient, session.user.id, session.user.email, "[RESET PASSWORD]");
  } catch (err) {
    console.error("RESET PASSWORD HOUSEHOLD SETUP ERROR:", err.message);
    return res.status(500).json({ error: "failed" });
  }

  setSessionCookies(res, session);
  return res.json({ ok: true });
});

// TEMPORARY diagnostic beacon (2026-08-23 physical iOS Voice SDK
// verification pass) — unauthenticated on purpose, so a client-side
// failure before a valid session/token exists is still observable.
// Remove once CallKit reception is confirmed working. Never logs
// anything beyond a stage label and an optional error string.
app.post("/debug/voice-beacon", express.json(), (req, res) => {
  console.log("VOICE BEACON:", req.body && req.body.stage, req.body && req.body.detail);
  res.json({ ok: true });
});

// PAGES

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

// Auth only, deliberately not requireEntitlement — an unsubscribed
// household must still be able to reach the dashboard shell to see the
// "Get Protected Today" prompt and start Checkout from it. The page's own
// /dashboard-data fetch (requireEntitlement-gated) is what actually decides
// whether the protected view or the subscribe prompt renders.
app.get("/dashboard", requireAuth, (req, res) => {
  res.sendFile(__dirname + "/upload.html");
});

// START SERVER
//
// The staging safeguard above catches a wrong project ref or an obviously
// live-prefixed key synchronously at boot from the key's shape alone. This
// closes the gap prefix-matching can't: whether a syntactically
// sk_test_-shaped key is actually in test mode right now is something
// only Stripe's own account state can confirm, so ask it directly with a
// read-only, no-side-effect call (balance.retrieve — no billing action)
// before accepting traffic. Same gate as the sync check: only for an
// explicitly-selected non-production environment.
async function startServer() {
  if (ENV_FILE && process.env.NODE_ENV !== "production" && stripe) {
    try {
      const balance = await stripe.balance.retrieve();
      if (balance.livemode) {
        console.error(
          `FATAL: Stripe reports livemode=true for the key loaded from ENV_FILE=${ENV_FILE} — refusing to start a non-production process against live Stripe.`
        );
        process.exit(1);
      }
      console.log("[env] Stripe account confirmed test mode (livemode=false).");
    } catch (err) {
      console.error(`FATAL: could not verify the Stripe account's mode: ${err.message}`);
      process.exit(1);
    }
  }

  const httpServer = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  // Restoring progressive monitoring (2026-08-11): the WebSocket endpoint
  // Twilio's <Start><Stream> (attachLiveMonitoring, above) connects to.
  // Attached to the same http.Server app.listen() returns — no second
  // port, no second process. A missing OpenAI/Twilio client is handled
  // the same fail-open way the rest of this file already treats them
  // (transcription/SMS simply won't succeed; the call itself is
  // completely unaffected either way, since <Start><Stream> is fire-and-
  // forget relative to <Dial>).
  attachMediaStreamServer(httpServer, {
    transcribeClient: openai ? createOpenAiTranscribeClient(openai) : null,
    smsClient: twilioRestClient,
    fromNumber: null,
    twilioRestClient,
    redLineRedirectUrl: buildRedLineTerminateUrl(APP_URL),
    recordOutcome: recordMonitoringOutcome,
  });
}

startServer();