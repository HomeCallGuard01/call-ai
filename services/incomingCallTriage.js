// Incoming-call incident triage — pure classification, no network/DB.
//
// Written 2026-09-28 after "our normal mobile numbers aren't accepting
// incoming calls" was reported for two internal test households. The
// first question in that kind of incident is always the same: did the
// failed calls reach Twilio/HCG at all? This module turns read-only
// evidence (the household row, the Twilio number's inventory entry, the
// Twilio call records for that number and their child legs, and Twilio
// Monitor push-failure alerts) into one of a small set of verdicts, so
// the answer comes from data rather than from memory of a previous
// investigation. scripts/triage-incoming-calls.js does the fetching.
//
// Verdict meanings:
//   number_not_owned        — household's twilio_number is no longer in
//                             the Twilio account (released). A handset
//                             still diverting to it fails at the carrier
//                             and the call never reaches HCG.
//   webhook_not_production  — the number's voice_url is not a
//                             production host (e.g. a staging ngrok
//                             tunnel); calls reach Twilio but not prod.
//   no_traffic_in_window    — nothing reached the number in the window.
//                             If calls to the ordinary mobile failed in
//                             that window, they never reached HCG:
//                             handset/carrier/diversion side.
//   delivery_failing        — calls reached HCG but the most recent
//                             approved delivery (client leg) did not
//                             connect. HCG is dropping diverted calls.
//   delivering              — most recent approved delivery connected.
//   reaching_hcg            — calls arrived, but none were dialled to the
//                             app (e.g. all screened/blocked).

const PRODUCTION_VOICE_HOSTS = new Set([
  "www.homecallguard.co.uk",
  "homecallguard.co.uk",
]);

function isProductionVoiceUrl(voiceUrl) {
  if (!voiceUrl) return false;
  let url;
  try {
    url = new URL(voiceUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.pathname !== "/voice") return false;
  return (
    PRODUCTION_VOICE_HOSTS.has(url.hostname) ||
    /^call-ai-production(-[a-z0-9]+)?\.up\.railway\.app$/.test(url.hostname)
  );
}

// Never print full phone numbers or client identities in triage output.
function maskNumber(value) {
  if (!value) return value == null ? null : "";
  if (value.startsWith("client:")) return "client:…" + value.slice(-4);
  if (value.length <= 8) return "…" + value.slice(-3);
  return value.slice(0, 5) + "…" + value.slice(-3);
}

// Twilio Monitor alert_text for Voice push failures (e.g. 52103) is a
// form-encoded string such as
//   bindingType=fcm&primaryCorrelationId=CA…&description=FCM+failure='NotRegistered'
// primaryCorrelationId is the client (child) leg's CallSid.
function parsePushFailureAlert(alertText) {
  if (!alertText) return null;
  const params = new URLSearchParams(alertText);
  const callSid = params.get("primaryCorrelationId");
  if (!callSid) return null;
  const description = params.get("description") || "";
  const failure = (description.match(/failure='([^']+)'/) || [])[1] || description || null;
  return { callSid, bindingType: params.get("bindingType"), failure };
}

function startTimeOf(call) {
  return new Date(call.start_time || call.date_created).getTime();
}

// calls: Twilio Call resources for inbound calls To the household's
// number, plus their outbound-dial child legs (parent_call_sid set).
// alerts: Twilio Monitor Alert resources (only push failures are used).
function classifyIncomingCallHealth({ household, inventoryNumber, calls = [], alerts = [] }) {
  const findings = [];

  if (!household || !household.twilio_number) {
    return { verdict: "no_hcg_number", findings: ["household has no twilio_number"], attempts: [] };
  }
  if (!inventoryNumber) {
    return {
      verdict: "number_not_owned",
      findings: [`${maskNumber(household.twilio_number)} is not in the Twilio account — diverted calls to it fail at the carrier`],
      attempts: [],
    };
  }
  if (!isProductionVoiceUrl(inventoryNumber.voice_url)) {
    findings.push(`voice_url is not a production host: ${inventoryNumber.voice_url || "(empty)"}`);
  }

  const pushFailures = new Map();
  for (const alert of alerts) {
    const parsed = parsePushFailureAlert(alert.alert_text);
    if (parsed) pushFailures.set(parsed.callSid, parsed);
  }

  const childrenByParent = new Map();
  for (const call of calls) {
    if (!call.parent_call_sid) continue;
    if (!childrenByParent.has(call.parent_call_sid)) childrenByParent.set(call.parent_call_sid, []);
    childrenByParent.get(call.parent_call_sid).push(call);
  }

  const attempts = calls
    .filter(c => !c.parent_call_sid && c.direction === "inbound" && c.to === household.twilio_number)
    .sort((a, b) => startTimeOf(a) - startTimeOf(b))
    .map(parent => {
      const legs = childrenByParent.get(parent.sid) || [];
      const clientLeg = legs.find(l => (l.to || "").startsWith("client:")) || null;
      const push = clientLeg ? pushFailures.get(clientLeg.sid) || null : null;
      return {
        callSid: parent.sid,
        at: new Date(startTimeOf(parent)).toISOString(),
        from: maskNumber(parent.from),
        parentStatus: parent.status,
        clientLegStatus: clientLeg ? clientLeg.status : null,
        pushFailure: push ? `${push.bindingType}:${push.failure}` : null,
      };
    });

  if (findings.length) {
    return { verdict: "webhook_not_production", findings, attempts };
  }
  if (attempts.length === 0) {
    return {
      verdict: "no_traffic_in_window",
      findings: ["no inbound calls reached this HCG number in the window — failed calls to the ordinary mobile in this window did not reach HCG"],
      attempts,
    };
  }

  const dialled = attempts.filter(a => a.clientLegStatus);
  if (dialled.length === 0) {
    return { verdict: "reaching_hcg", findings: ["calls arrived but none were dialled to the app"], attempts };
  }
  const last = dialled[dialled.length - 1];
  if (last.clientLegStatus === "completed") {
    return { verdict: "delivering", findings, attempts };
  }
  const failed = dialled.filter(a => a.clientLegStatus !== "completed");
  findings.push(`${failed.length}/${dialled.length} app deliveries failed; most recent ${last.at} (${last.clientLegStatus})`);
  const pushed = failed.filter(a => a.pushFailure);
  if (pushed.length) {
    findings.push(`push failures on failed legs: ${[...new Set(pushed.map(a => a.pushFailure))].join(", ")} — app push binding is stale; reopen/reinstall the app to re-register`);
  }
  return { verdict: "delivery_failing", findings, attempts };
}

// Operator-facing answers (2026-09-29). Combines the Twilio-side verdict
// above with the DB-side delivery health (services/deliveryHealth.js)
// and per-call app evidence. Every answer is "yes" | "no" | "unknown" —
// never a guess presented as a fact.
//   triage: classifyIncomingCallHealth result
//   health: computeDeliveryHealth result (or null)
//   latestDbAttempt: most recent calls row with dial_call_status (or null)
function answerTriageQuestions({ triage, health = null, latestDbAttempt = null }) {
  const attempts = (triage && triage.attempts) || [];
  const last = attempts[attempts.length - 1] || null;
  const yn = v => (v === true ? "yes" : v === false ? "no" : "unknown");

  const reachedHcg = triage && triage.verdict === "number_not_owned" ? false : attempts.length > 0 ? true : false;
  const appDeliveryAttempted = last ? Boolean(last.clientLegStatus) : null;
  // "no" only when the device itself confirmed the invite arrived; the
  // mere absence of a push-failure alert is not proof the push worked.
  const clientRang = latestDbAttempt && latestDbAttempt.client_invite_received_at ? true : null;
  const hasPushFailure = Boolean((last && last.pushFailure) || (latestDbAttempt && latestDbAttempt.push_failure));
  const pushFailed = !appDeliveryAttempted ? null : hasPushFailure ? true : clientRang ? false : null;
  const answered = last && last.clientLegStatus ? last.clientLegStatus === "completed" : null;

  const nextSteps = [];
  switch (triage && triage.verdict) {
    case "number_not_owned":
      nextSteps.push("The HCG number is no longer in the Twilio account. Ask the customer to dial *#21# and cancel the divert (##21#) — calls cannot reach HCG.");
      break;
    case "webhook_not_production":
      nextSteps.push("The HCG number's voice webhook is not production. Check whether this is a staging number that a real handset is diverting to.");
      break;
    case "no_traffic_in_window":
      nextSteps.push("Nothing reached HCG. Ask the customer to dial *#21# to confirm the divert target matches the HCG number; check PAYG credit on the mobile line.");
      break;
    case "delivery_failing":
      nextSteps.push("Calls reach HCG but not the app. Ask the customer to open the app (re-registers the push token), then place one test call.");
      if (attempts.some(a => a.pushFailure)) nextSteps.push("Push provider rejected the device token: reinstall/reopen is required; re-registration alone was not sufficient on 2026-09-26 — confirm with a real call.");
      nextSteps.push("If the app will not reconnect, the customer should turn off call forwarding (##21#) until it does, so callers are not dropped.");
      break;
    case "reaching_hcg":
      nextSteps.push("Calls arrive but none were put through to the app — check screening decisions and entitlement for this household.");
      break;
    default:
      break;
  }
  if (health && health.state === "UNREGISTERED") nextSteps.push("The app has never registered for calls on this household — setup is incomplete.");

  return {
    reachedHcg: yn(reachedHcg),
    appDeliveryAttempted: yn(appDeliveryAttempted),
    pushFailed: yn(pushFailed),
    clientRang: yn(clientRang),
    answered: yn(answered),
    registrationState: health ? health.state : "unknown",
    nextSteps,
  };
}

module.exports = {
  answerTriageQuestions,
  classifyIncomingCallHealth,
  isProductionVoiceUrl,
  maskNumber,
  parsePushFailureAlert,
};
