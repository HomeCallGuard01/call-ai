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
  apiKey: "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",
});

// STEP 1: Answer call
app.post("/voice", (req, res) => {  

  const caller = req.body.From;
  console.log("Incoming caller:", caller);

  let contacts = [];
  try {
    contacts = JSON.parse(fs.readFileSync("contacts.json", "utf8"));
  } catch (e) {
    contacts = [];
  }

  const normalize = num =>
  num.replace(/\D/g, "").replace(/^44/, "0");

const isKnown = contacts.some(c =>
  normalize(c.number) === normalize(caller)
);

  const twiml = new VoiceResponse();

  // ✅ KNOWN CALLER → BYPASS AI
  if (isKnown) {
    console.log("Known caller:", caller);
    const dial = twiml.dial({
  callerId: req.body.To
});

dial.number("+447715562700");

    return res.type("text/xml").send(twiml.toString());
  }

  // ❗ UNKNOWN CALLER → GO TO AI
  const gather = twiml.gather({
    input: "speech",
    action: "/process",
    speechTimeout: "auto",
  });

  gather.say(
    {
      voice: "Polly.Amy",
      language: "en-GB"
    },
    "This call is protected by Home Call Guard. Please briefly state your reason for calling."
  );

  res.type("text/xml");
  res.send(twiml.toString());
});

// STEP 2: Process speech
app.post("/process", async (req, res) => {
  const twiml = new VoiceResponse();

  const speech = req.body.SpeechResult || "";
  console.log("Caller said:", speech);
const lowerSpeech = speech.toLowerCase();

if (
  lowerSpeech.includes("sky") ||
  lowerSpeech.includes("bt") ||
  lowerSpeech.includes("amazon") ||
  lowerSpeech.includes("bank") ||
  lowerSpeech.includes("account") ||
  lowerSpeech.includes("internet") ||
  lowerSpeech.includes("broadband")
) {
  console.log("Blocked by keyword");

  twiml.say({
    voice: "Polly.Amy",
    language: "en-GB"
  }, "This call cannot be completed. Goodbye.");

  twiml.hangup();

  return res.type("text/xml").send(twiml.toString());
}
  const aiResponse = await openai.chat.completions.create({
    model: "gpt-4o-mini",
messages: [
  {
    role: "system",
    content: `You are an advanced scam detection system.
    
Classify the call as YES (scam) or NO (safe).
  
Mark as YES if the caller:
- Mentions bank, account, card, payment, refund
- Mentions security, verification, OTP, passcode
- Mentions broadband, Sky, BT, internet provider issues
- Mentions Amazon, delivery problems, fake orders
- Mentions HMRC, tax, fines, legal threats
- Mentions crypto, bitcoin, investment opportunities
- Uses urgency (e.g. urgent, act now, immediately)
- Asks for personal or financial information
  
Also flag:
- Pressure tactics
- Scripted or robotic language
- Suspicious tone or intent
  
Otherwise return NO.
  
Respond ONLY with YES or NO.`,
  },
  { 
    role: "user",
    content: speech,
  },
],
});

  const result = aiResponse.choices[0].message.content.trim();
  console.log("AI decision:", result);

  if (result === "YES") {
  twiml.say({
    voice: "Polly.Amy",
    language: "en-GB"
  }, "This call cannot be completed. Goodbye.");
  
  twiml.hangup();

} else {

  const dial = twiml.dial();
  dial.number("+447715562700");

}

  res.type("text/xml");
  res.send(twiml.toString());
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
