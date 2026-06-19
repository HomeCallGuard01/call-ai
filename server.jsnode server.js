
const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const OpenAI = require("openai");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const VoiceResponse = twilio.twiml.VoiceResponse;

const openai = new OpenAI({
  apiKey: "YOUR_OPENAI_API_KEY",
});

// STEP 1: Answer call and ask question
app.post("/voice", (req, res) => {
  const twiml = new VoiceResponse();

  const gather = twiml.gather({
    input: "speech",
    action: "/process",
    speechTimeout: "auto",
  });

  gather.say(
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

  const aiResponse = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a scam detector. Reply only YES or NO. YES = scam, NO = safe.",
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
    twiml.say("This call cannot be completed. Goodbye.");
    twiml.hangup();
  } else {
    twiml.say("Connecting your call.");
    twiml.dial("+447715562700"); // CHANGE THIS TO YOUR NUMBER
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});

