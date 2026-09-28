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
const { classifyIncomingCallHealth, maskNumber } = require("../services/incomingCallTriage");

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

  console.log(`\n== household ${household.id.slice(0, 8)} — HCG number ${maskNumber(household.twilio_number)}`);
  console.log(`   status=${household.status} provisioning=${household.twilio_provisioning_status} pending_release=${household.twilio_number_pending_release_at || "-"}`);
  console.log(`   voice_client_registered_at=${household.voice_client_registered_at || "-"} delivery_verified_at=${household.delivery_verified_at || "-"} carrier=${household.carrier_provider_key || "-"}`);
  console.log(`   VERDICT: ${result.verdict}`);
  for (const finding of result.findings) console.log(`   - ${finding}`);
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
