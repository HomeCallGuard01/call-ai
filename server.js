require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const OpenAI = require("openai");
const fs = require("fs");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static("public"));

const VoiceResponse = twilio.twiml.VoiceResponse;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
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

async function getContacts() {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("SUPABASE CONTACT READ ERROR:", error);
    return [];
  }

  return data || [];
}

async function getCallsToday() {
  if (!supabaseAdmin) return [];

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const { data, error } = await supabaseAdmin
    .from("calls")
    .select("*")
    .gte("created_at", startOfToday.toISOString());

  if (error) {
    console.error("SUPABASE CALLS READ ERROR:", error);
    return [];
  }

  return data || [];
}

async function getRecentCalls(limit) {
  if (!supabaseAdmin) return [];

  const { data, error } = await supabaseAdmin
    .from("calls")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("SUPABASE CALLS READ ERROR:", error);
    return [];
  }

  return data || [];
}

async function logCall({ callSid, number, status, result, aiModel, processingTimeMs }) {
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

  const contacts = await getContacts();
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

  const contacts = await getContacts();
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

  logCall({
    callSid,
    number: from,
    status: isKnown ? "Known" : "Unknown",
    result: isScam ? "SCAM" : "SAFE",
    aiModel,
    processingTimeMs: Date.now() - processingStart,
  }).catch(err => console.error("CALL LOG FAILED:", err.message));

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

app.get("/dashboard-data", async (req, res) => {
  const [contacts, callsToday, recentCalls] = await Promise.all([
    getContacts(),
    getCallsToday(),
    getRecentCalls(10),
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

app.get("/test-get-contacts", async (req, res) => {
  const contacts = await getContacts();
  res.json({ success: true, data: contacts });
});

app.get("/logs", async (req, res) => {
  const calls = await getRecentCalls(200);
  res.json(calls.map(toClientCall));
});

// UPLOAD CONTACTS

app.post("/upload-contacts", upload.single("file"), async (req, res) => {
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

    const { data: savedContacts, error } = await supabase
      .from("contacts")
      .insert(contacts)
      .select();

    if (error) {
      console.error("SUPABASE CONTACT UPLOAD ERROR:", error);
      return res.status(500).send("Contacts upload failed");
    }

    res.send(
      `Contacts uploaded successfully! ${savedContacts.length} contacts saved to Supabase.`
    );
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).send("Upload failed");
  }
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