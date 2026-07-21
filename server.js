require("dotenv").config();

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
const { getContacts, insertContacts } = require("./database/contacts");
const { getActiveEntitlement } = require("./database/billing");
const billingRoutes = require("./routes/billing");
const adminRoutes = require("./routes/admin");
const { resolvePort, validateProductionEnv } = require("./services/serverConfig");

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

const app = express();
const upload = multer({ dest: "uploads/" });
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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function normaliseNumber(number) {
  return (number || "").replace(/\D/g, "").slice(-10);
}

async function getCallsToday(householdId) {
  if (!supabaseAdmin) return [];

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const { data, error } = await supabaseAdmin
    .from("calls")
    .select("*")
    .eq("household_id", householdId)
    .gte("created_at", startOfToday.toISOString());

  if (error) {
    console.error("SUPABASE CALLS READ ERROR:", error);
    return [];
  }

  return data || [];
}

async function getRecentCalls(householdId, limit) {
  if (!supabaseAdmin) return [];

  const { data, error } = await supabaseAdmin
    .from("calls")
    .select("*")
    .eq("household_id", householdId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("SUPABASE CALLS READ ERROR:", error);
    return [];
  }

  return data || [];
}

async function logCall({ callSid, number, status, result, aiModel, processingTimeMs, householdId }) {
  if (!supabaseAdmin) {
    console.error("SUPABASE CALL LOG ERROR: SUPABASE_SERVICE_ROLE_KEY not configured");
    return;
  }

  const { error } = await supabaseAdmin
    .from("calls")
    .upsert(
      {
        call_sid: callSid,
        number,
        status,
        result,
        ai_model: aiModel,
        processing_time_ms: processingTimeMs,
        household_id: householdId,
      },
      { onConflict: "call_sid", ignoreDuplicates: true }
    );

  if (error) {
    console.error("SUPABASE CALL LOG ERROR:", error);
  }
}

function toClientCall(call) {
  return {
    number: call.number,
    status: call.status,
    result: call.result,
    time: call.created_at,
  };
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

    const dial = twiml.dial();
    dial.number("+447715562700");

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

  const lower = speech.toLowerCase();

  const isKeywordScam =
    lower.includes("bank") ||
    lower.includes("account") ||
    lower.includes("bitcoin") ||
    lower.includes("amazon") ||
    lower.includes("refund") ||
    lower.includes("internet") ||
    lower.includes("broadband") ||
    lower.includes("bt") ||
    lower.includes("sky") ||
    lower.includes("urgent") ||
    lower.includes("payment");

  let isScam = isKeywordScam;
  let result = "SAFE";
  let aiModel = null;

  if (!isKeywordScam && speech.length > 5) {
    try {
      const aiResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Classify this call as SCAM or SAFE. Only respond SCAM or SAFE.",
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
    twiml.say(
      { voice: "Polly.Amy", language: "en-GB" },
      "This call is being connected via Home Call Guard. Please be cautious when sharing personal information."
    );

    twiml.pause({ length: 1 });

    const dial = twiml.dial();
    dial.number("+447715562700");
  }

  return res.type("text/xml").send(twiml.toString());
});

// DASHBOARD API

app.get("/dashboard-data", requireAuth, requireEntitlement, async (req, res) => {
  const [callsToday, recentCalls, contacts] = await Promise.all([
    getCallsToday(req.household.id),
    getRecentCalls(req.household.id, 10),
    getContacts(req.household.id),
  ]);

  res.json({
    // req.household already carries these — requireAuth's
    // getHouseholdByAuthUserId does a plain select("*"), so no extra
    // query is needed for the household's own provisioning state.
    twilioNumber: req.household.twilio_number || null,
    twilioProvisioningStatus: req.household.twilio_provisioning_status || "pending",
    contactsUploaded: contacts.length,
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
  });
});

app.get("/logs", requireAuth, requireEntitlement, async (req, res) => {
  const calls = await getRecentCalls(req.household.id, 200);
  res.json(calls.map(toClientCall));
});

// UPLOAD CONTACTS

app.post("/upload-contacts", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const entitlement = await getActiveEntitlement(req.household.id);
    if (!entitlement) {
      return res.status(402).send("An active subscription is required to upload contacts.");
    }

    if (!req.file) {
      return res.status(400).send("No file uploaded");
    }

    const filePath = req.file.path;
    const data = fs.readFileSync(filePath, "utf8");

    const contacts = data
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => {
        const parts = line.split(",");

        return {
          name: parts[0]?.trim() || "Unknown",
          number: normaliseNumber(parts[1]),
          customer_id: null,
        };
      })
      .filter(c => c.number.length === 10);

    if (contacts.length === 0) {
      return res.status(400).send("No valid contacts found in CSV");
    }

    const savedContacts = await insertContacts(req.household.id, contacts);

    res.send(
      `Contacts uploaded successfully! ${savedContacts.length} contacts saved to Supabase.`
    );
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).send("Upload failed");
  }
});

// AUTH HELPERS

// Builds a Supabase client scoped to one specific user's own session —
// never the shared `supabase` instance above, and never the service-role
// key. Used anywhere a request needs to act as that user under RLS.
function buildUserScopedClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

// Ensures the signed-in user has a household and a user_roles row, using
// only that user's own authenticated session — no service-role key
// anywhere in this path. Relies on the policies added in
// supabase/migrations/006_authenticated_household_self_service.sql. Safe
// to call on every registration/login: it's a no-op if both already exist.
//
// logPrefix drives the TEMPORARY DEBUG LOGGING below — remove both once
// the first-login household/role flow is confirmed working end to end.
async function ensureHouseholdAndRole(userClient, userId, email, logPrefix) {
  const log = msg => {
    if (logPrefix) console.log(`${logPrefix} ${msg}`);
  };

  log("Checking household");
  const { data: existingHousehold, error: householdSelectError } = await userClient
    .from("households")
    .select("id")
    .eq("auth_user_id", userId)
    .maybeSingle();

  if (householdSelectError) throw householdSelectError;

  log(`Household exists? ${!!existingHousehold}`);

  if (!existingHousehold) {
    log("Creating household...");

    // Try to claim the pre-existing unclaimed default household first.
    const { data: claimed, error: claimError } = await userClient
      .from("households")
      .update({ auth_user_id: userId, email })
      .is("auth_user_id", null)
      .select();

    if (claimError) throw claimError;

    if (!claimed || claimed.length === 0) {
      // Nothing unclaimed to take — create a brand-new household instead.
      const { error: insertError } = await userClient
        .from("households")
        .insert({ auth_user_id: userId, email, status: "active" });

      if (insertError) throw insertError;
    }

    log("Household created");
  }

  const { data: existingRole, error: roleSelectError } = await userClient
    .from("user_roles")
    .select("auth_user_id")
    .eq("auth_user_id", userId)
    .maybeSingle();

  if (roleSelectError) throw roleSelectError;

  if (!existingRole) {
    log("Creating role...");

    const { error: roleInsertError } = await userClient
      .from("user_roles")
      .insert({ auth_user_id: userId, role: "household" });

    if (roleInsertError) throw roleInsertError;

    log("Role created");
  }
}

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

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${APP_URL}/confirmed.html`,
    },
  });

  if (error) {
    console.error("SUPABASE SIGNUP ERROR:", error.message);
    return res.redirect(
      `/register.html?state=error&reason=failed&email=${encodeURIComponent(email)}`
    );
  }

  // Email confirmation is required on this project, so signUp() does not
  // return a session here — household/role creation happens on first
  // login instead (see /login below), once a real session exists.
  if (!data.session) {
    return res.redirect("/register.html?state=success");
  }

  // Only reachable if email confirmation is ever turned off: signUp()
  // would then return a session immediately, so household/role setup can
  // happen right away instead of waiting for first login.
  try {
    const userClient = buildUserScopedClient();
    await userClient.auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
    await ensureHouseholdAndRole(userClient, data.user.id, email, "[REGISTER]");
  } catch (err) {
    console.error("REGISTER HOUSEHOLD SETUP ERROR:", err.message);
    return res.redirect(
      `/register.html?state=error&reason=failed&email=${encodeURIComponent(email)}`
    );
  }

  setSessionCookies(res, data.session);
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
  // see ensureHouseholdAndRole() above. No-op on every login after that.
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

app.post("/resend-confirmation", async (req, res) => {
  const { email } = req.body;

  if (email) {
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: {
        emailRedirectTo: `${APP_URL}/confirmed.html`,
      },
    });

    // Logged server-side only — never surfaced to the customer, whether
    // it's a rate limit, an unknown address, or anything else. The
    // response is identical either way so this never reveals whether an
    // account exists for that email.
    if (error) {
      console.error("SUPABASE RESEND CONFIRMATION ERROR:", error.message);
    }
  }

  res.redirect("/login.html?state=resent");
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

  setSessionCookies(res, session);
  return res.json({ ok: true });
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});