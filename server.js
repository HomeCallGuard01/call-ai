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
const { getHouseholdByTwilioNumber } = require("./database/households");
const { getContacts, insertContacts } = require("./database/contacts");

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static("public"));

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

app.get("/dashboard-data", requireAuth, async (req, res) => {
  const [contacts, callsToday, recentCalls] = await Promise.all([
    getContacts(req.household.id),
    getCallsToday(req.household.id),
    getRecentCalls(req.household.id, 10),
  ]);

  res.json({
    protectedContacts: contacts.length,
    callsToday: callsToday.length,
    blocked: callsToday.filter(call => call.result === "SCAM").length,
    safe: callsToday.filter(call => call.result === "SAFE").length,
    recentCalls: recentCalls.map(toClientCall),
  });
});

// TEST ROUTES

app.get("/test-db", async (req, res) => {
  res.json({
    connected: true,
    url: process.env.SUPABASE_URL,
  });
});

app.get("/test-get-contacts", requireAuth, async (req, res) => {
  const contacts = await getContacts(req.household.id);
  res.json({ success: true, data: contacts });
});

app.get("/logs", requireAuth, async (req, res) => {
  const calls = await getRecentCalls(req.household.id, 200);
  res.json(calls.map(toClientCall));
});

// UPLOAD CONTACTS

app.post("/upload-contacts", requireAuth, upload.single("file"), async (req, res) => {
  try {
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

  const { data, error } = await supabase.auth.signUp({ email, password });

  // TEMPORARY DEBUG LOGGING — remove once household creation is confirmed working.
  console.log("DEBUG /register signUp result:", {
    error: error?.message || null,
    userId: data?.user?.id || null,
    hasSession: !!data?.session,
    userConfirmedAt: data?.user?.confirmed_at || null,
    userEmailConfirmedAt: data?.user?.email_confirmed_at || null,
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
    return res.status(400).send("Email and password are required");
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.session) {
    console.error("SUPABASE LOGIN ERROR:", error?.message);
    return res.redirect("/login.html?error=invalid_credentials");
  }

  // TEMPORARY DEBUG LOGGING — remove once household creation is confirmed working.
  console.log("[LOGIN] User authenticated");

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
      redirectTo: `${process.env.APP_URL}/reset-password.html`,
    });

    if (error) {
      console.error("SUPABASE RESET EMAIL ERROR:", error.message);
    }
  }

  // Same response whether or not the email is registered, to avoid
  // leaking which addresses have accounts.
  res.send("If that email is registered, a password reset link has been sent.");
});

// AUTH: RESET PASSWORD COMPLETE

app.post("/reset-password-complete", async (req, res) => {
  const { access_token, refresh_token, new_password } = req.body;

  if (!access_token || !refresh_token || !new_password) {
    return res.status(400).send("Missing reset token or new password");
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
    return res.status(400).send("Password reset link is invalid or has expired.");
  }

  const { error: updateError } = await resetClient.auth.updateUser({
    password: new_password,
  });

  if (updateError) {
    console.error("SUPABASE PASSWORD UPDATE ERROR:", updateError.message);
    return res.status(400).send("Password reset failed. Please try again.");
  }

  const {
    data: { session },
  } = await resetClient.auth.getSession();

  setSessionCookies(res, session);
  return res.redirect("/dashboard");
});

// PAGES

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

app.get("/dashboard", (req, res) => {
  res.sendFile(__dirname + "/upload.html");
});

// START SERVER

app.listen(3000, () => {
  console.log("Server running on port 3000");
});