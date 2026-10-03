// READ-ONLY incoming-call incident triage for one or more households.
//
// Answers "are this household's diverted calls reaching HCG, and if so
// are they being delivered to the app?" from live Supabase + Twilio
// evidence. Performs GET/SELECT requests only — never updates a
// household, a Twilio number, or a call. Prints masked numbers only.
// Classification logic lives in services/incomingCallTriage.js (unit
// tested in tests/incoming-call-triage.test.mjs).
//
// Run with:
//   node scripts/triage-incoming-calls.js <household-id-or-prefix> [...] [--since 2026-09-25]
// Default window: last 72 hours.

require("dotenv").config();

const twilio = require("twilio");
const { supabaseAdmin } = require("../services/supabaseClients");
const { classifyIncomingCallHealth, answerTriageQuestions, maskNumber } = require("../services/incomingCallTriage");
const { computeDeliveryHealth, attemptFromCallRow } = require("../services/deliveryHealth");
const { getRecentDeliveryAttempts, hasVerifiedInviteReporting } = require("../database/deliveryEvidence");

function parseArgs(argv) {
  const ids = [];
  let since = new Date(Date.now() - 72 * 3600 * 1000);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--since") since = new Date(argv[++i]);
    else ids.push(argv[i]);
  }
  if (Number.isNaN(since.getTime())) throw new Error("--since is not a valid date");
  return { ids, since };
}

async function findHousehold(idOrPrefix) {
  const { data, error } = await supabaseAdmin
    .from("households")
    .select("id,twilio_number,status,twilio_provisioning_status,twilio_number_pending_release_at,voice_client_registered_at,delivery_verified_at,activation_verified_at,carrier_provider_key,device_type")
    .not("twilio_number", "is", null);
  if (error) throw new Error(`households lookup failed: ${error.message}`);
  const matches = data.filter(h => h.id.startsWith(idOrPrefix));
  if (matches.length !== 1) throw new Error(`"${idOrPrefix}" matched ${matches.length} households with a twilio_number`);
  return matches[0];
}

async function triageHousehold(client, idOrPrefix, since) {
  const household = await findHousehold(idOrPrefix);
  const [inventory] = await client.incomingPhoneNumbers.list({ phoneNumber: household.twilio_number, limit: 1 });
  const parents = await client.calls.list({ to: household.twilio_number, startTimeAfter: since, limit: 500 });
  const children = [];
  for (const parent of parents) {
    children.push(...(await client.calls.list({ parentCallSid: parent.sid, limit: 20 })));
  }
  const alerts = await client.monitor.v1.alerts.list({ startDate: since, limit: 500 });

  // The SDK returns camelCase; the classifier takes Twilio's REST field names.
  const toRest = c => ({
    sid: c.sid,
    parent_call_sid: c.parentCallSid,
    direction: c.direction,
    from: c.from,
    to: c.to,
    status: c.status,
    start_time: c.startTime,
    date_created: c.dateCreated,
  });
  const result = classifyIncomingCallHealth({
    household,
    inventoryNumber: inventory ? { voice_url: inventory.voiceUrl } : null,
    calls: [...parents, ...children].map(toRest),
    alerts: alerts.map(a => ({ alert_text: a.alertText })),
  });

  // DB-side evidence (read-only): recent delivery attempts, whether this
  // household's app has ever reported a CallInvite, registration history.
  const [dbAttempts, inviteReportingVerified, registrations] = await Promise.all([
    getRecentDeliveryAttempts({ supabase: supabaseAdmin, householdId: household.id }),
    hasVerifiedInviteReporting({ supabase: supabaseAdmin, householdId: household.id }),
    supabaseAdmin
      .from("voice_client_registration_events")
      .select("registered_at, app_platform, app_version, app_build_version")
      .eq("household_id", household.id)
      .order("registered_at", { ascending: false })
      .limit(5)
      .then(r => r.data || []),
  ]);
  // Push failures live in Twilio Monitor until migration 055 + the
  // push-failure poller are live; fold the Twilio-side evidence in so the
  // health shown here is what the model concludes with full evidence.
  const pushByParent = new Map(result.attempts.filter(a => a.pushFailure).map(a => [a.callSid, a.pushFailure]));
  const health = computeDeliveryHealth({
    attempts: dbAttempts.map(row => ({
      ...attemptFromCallRow(row),
      pushFailure: row.push_failure || pushByParent.get(row.call_sid) || null,
    })),
    lastRegisteredAt: household.voice_client_registered_at,
    inviteReportingVerified,
  });
  const lastAttempt = result.attempts[result.attempts.length - 1];
  const latestDbAttempt = lastAttempt ? dbAttempts.find(r => r.call_sid === lastAttempt.callSid) || null : null;
  const answers = answerTriageQuestions({ triage: result, health, latestDbAttempt });

  console.log(`\n== household ${household.id.slice(0, 8)} — HCG number ${maskNumber(household.twilio_number)}`);
  console.log(`   status=${household.status} provisioning=${household.twilio_provisioning_status} pending_release=${household.twilio_number_pending_release_at || "-"}`);
  console.log(`   voice_client_registered_at=${household.voice_client_registered_at || "-"} delivery_verified_at=${household.delivery_verified_at || "-"} carrier=${household.carrier_provider_key || "-"}`);
  console.log(`   VERDICT: ${result.verdict}`);
  for (const finding of result.findings) console.log(`   - ${finding}`);
  console.log(`   DELIVERY HEALTH: ${health.state} (consecutive failures ${health.consecutiveFailures}: hard ${health.hardFailures}, soft ${health.softFailures}; last success ${health.lastSuccessAt || "-"}; invite reporting ${inviteReportingVerified ? "verified" : "unverified"})`);
  for (const reason of health.reasons) console.log(`   - ${reason}`);
  console.log(`   Reached HCG: ${answers.reachedHcg} | App delivery attempted: ${answers.appDeliveryAttempted} | Push failed: ${answers.pushFailed} | Phone rang: ${answers.clientRang} | Answered: ${answers.answered}`);
  console.log(`   Registrations (latest 5): ${registrations.map(r => `${r.registered_at.slice(0, 16)} ${r.app_platform || "?"} ${r.app_version || "?"}/${r.app_build_version || "?"}`).join("; ") || "none recorded"}`);
  for (const step of answers.nextSteps) console.log(`   NEXT: ${step}`);
  for (const a of result.attempts) {
    console.log(`     ${a.at} from ${a.from} parent=${a.parentStatus} client=${a.clientLegStatus || "-"}${a.pushFailure ? " push=" + a.pushFailure : ""}`);
  }
}

async function main() {
  const { ids, since } = parseArgs(process.argv.slice(2));
  if (!ids.length) {
    console.error("usage: node scripts/triage-incoming-calls.js <household-id-or-prefix> [...] [--since ISO-date]");
    process.exitCode = 2;
    return;
  }
  if (!supabaseAdmin || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.error("TRIAGE ABORTED: Supabase admin client or Twilio credentials not configured");
    process.exitCode = 1;
    return;
  }
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  console.log(`Window: since ${since.toISOString()} (read-only)`);
  for (const id of ids) {
    try {
      await triageHousehold(client, id, since);
    } catch (err) {
      console.error(`\n== ${id}: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

main();
