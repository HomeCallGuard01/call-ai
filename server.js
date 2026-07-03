let callLogs = [];
const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const OpenAI = require("openai");
const fs = require("fs");

const multer = require("multer");
const upload = multer({ dest: "uploads/" });

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.send("Home Call Guard is live 👍");
});

const VoiceResponse = twilio.twiml.VoiceResponse;

// 🔑 ADD YOUR API KEY HERE (WITH QUOTES)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// STEP 1: Answer call
app.post("/voice", (req, res) => {
  const twiml = new VoiceResponse();

let contacts = [];
try {
  contacts = JSON.parse(fs.readFileSync("contacts.json", "utf8"));
} catch (e) {
  console.log("No contacts file yet");
}

const caller = req.body.From;

console.log("Incoming caller raw:", caller);
console.log("Normalised:", caller.replace(/\D/g, "").slice(-10));

// normalise number (important)
const callerNorm = caller.replace(/\D/g, "").slice(-10);

const isKnown = contacts.some(c =>
  c.number && c.number.replace(/\D/g, "").slice(-10) === callerNorm
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

app.post("/process", async (req, res) => {
  console.log("PROCESS HIT");

// ✅ ALWAYS create twiml FIRST
const twiml = new VoiceResponse();

// Get speech
const speech = req.body.SpeechResult || "";
console.log("Caller said:", speech);

const from = req.body.From;

// Load contacts safely
let contacts = [];
try {
  contacts = JSON.parse(fs.readFileSync("contacts.json", "utf8"));
} catch (e) {
  console.log("No contacts file yet");
}

// Check if caller is known
const isKnown = contacts.some(c => c.number === from);

// ✅ Handle empty speech safely
if (!speech || speech.length < 2) {
  twiml.say("Sorry, I didn't catch that. Please try again.");
  return res.type("text/xml").send(twiml.toString());
}

// Continue normal logic
const lower = speech.toLowerCase();

  // 🚫 BLOCK SCAM KEYWORDS
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

// 🧠 AI layer (only if not obvious)

let result = "SAFE";

if (!isKeywordScam && speech.length > 5) {
  try {
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Classify this call as SCAM or SAFE. Only respond SCAM or SAFE.",
        },
        {
          role: "user",
          content: speech,
        },
      ],
    });

    if (
      aiResponse &&
      aiResponse.choices &&
      aiResponse.choices[0] &&
      aiResponse.choices[0].message &&
      aiResponse.choices[0].message.content
    ) {
      result = aiResponse.choices[0].message.content.trim();
    }

    console.log("AI decision:", result);

    if (result === "SCAM") {
      isScam = true;
    }

  } catch (err) {
    console.log("AI failed:", err.message);
  }
}

callLogs.push({
  number: req.body.From,
  status: isKnown ? "Known" : "Unknown",
  result: isScam ? "SCAM" : "SAFE",
  time: new Date().toISOString()
});

app.get("/logs", (req, res) => {
  res.json(callLogs);
});

// 🚫 BLOCK
if (isScam) {
  twiml.say(
    { voice: "Polly.Amy", language: "en-GB" },
    "This call cannot be completed. Goodbye."
  );
  twiml.hangup();

} else {
  // ⚠️ If risky keywords detected, play stronger warning
  if (isKeywordScam) {
    twiml.say(
      { voice: "Polly.Amy", language: "en-GB" },
      "Warning. This call may involve financial requests. Do not transfer money or share bank details unless you are certain who you are speaking to."
    );
  } else {
    // normal protection message
    twiml.say(
      { voice: "Polly.Amy", language: "en-GB" },
      "This call is being connected via Home Call Guard. Please be cautious when sharing personal information."
    );
  }

  // short pause so message is heard
  twiml.pause({ length: 1 });

  // ✅ CONNECT CALL
  const dial = twiml.dial();
  dial.number("+447715562700");
}

  return res.type("text/xml").send(twiml.toString());
});




// START SERVER

app.post("/upload-contacts", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send("No file uploaded");
    }

    const filePath = req.file.path;
    const data = fs.readFileSync(filePath, "utf8");

    const lines = data.split(/\r?\n/);

    const contacts = lines
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => {
        const parts = line.split(",");

        let number = (parts[1] || "").replace(/\D/g, "");
        number = number.slice(-10);

        return {
          name: parts[0]?.trim(),
          number: number
        };
      })
      .filter(c => c.number.length === 10);

    fs.writeFileSync("contacts.json", JSON.stringify(contacts, null, 2));

    res.send("Contacts uploaded successfully!");
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).send("Upload failed");
  }
});


app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

app.get("/dashboard", (req, res) => {
  res.sendFile(__dirname + "/upload.html");
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
