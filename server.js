const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const OpenAI = require("openai");
const fs = require("fs");

const multer = require("multer");
const upload = multer({ dest: "uploads/" });

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(__dirname));

const VoiceResponse = twilio.twiml.VoiceResponse;

// 🔑 ADD YOUR API KEY HERE (WITH QUOTES)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// STEP 1: Answer call
app.post("/voice", (req, res) => {
  const twiml = new VoiceResponse();

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

app.post("/process", (req, res) => {
  console.log("PROCESS HIT");

  const speech = req.body.SpeechResult || "";
  console.log("Caller said:", speech);

  const lower = speech.toLowerCase();
  const twiml = new VoiceResponse();

  // 🚫 BLOCK SCAM KEYWORDS
  if (
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
    lower.includes("payment")
  ) {
    console.log("🚫 BLOCKED");

    twiml.say(
      { voice: "Polly.Amy", language: "en-GB" },
      "This call cannot be completed. Goodbye."
    );
    twiml.hangup();

  } else {
    console.log("✅ SAFE - connecting");

    const dial = twiml.dial();
    dial.number("+447715562700"); // your number
  }

  return res.type("text/xml").send(twiml.toString());
});




// STEP 2: Process speech
app.post("/process", (req, res) => {
  console.log("PROCESS HIT");

  const speech = req.body.SpeechResult || "nothing heard";
  console.log("Caller said:", speech);

  const twiml = new VoiceResponse();

  twiml.say(
    {
      voice: "Polly.Amy",
      language: "en-GB"
    },
    "Thank you. Goodbye."
  );

  twiml.hangup();

  return res.type("text/xml").send(twiml.toString());
});


// START SERVER


app.post("/upload-contacts", upload.single("file"), (req, res) => {
  const fs = require("fs");

  const filePath = req.file.path;
  const data = fs.readFileSync(filePath, "utf8");

  const lines = data.split("\n");

  const contacts = lines.map(line => {
    const parts = line.split(",");
    return {
      name: parts[0],
      number: parts[1]
    };
  });

  fs.writeFileSync("contacts.json", JSON.stringify(contacts, null, 2));

  res.send("Contacts uploaded successfully!");
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/upload.html");
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
