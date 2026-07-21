const { supabaseAdmin } = require("./supabaseClients");
const { stripe } = require("./stripeClient");
const { twilioRestClient } = require("./twilioClient");
const OpenAI = require("openai");

// Every check returns the same shape so the admin UI can render them
// uniformly: { name, status, latencyMs, message }.
// status is one of:
//   'ok'            — reached the real service and it responded normally
//   'error'         — configured, but the real call failed
//   'not_configured' — no credentials exist for this integration in this
//                      environment, so there is nothing real to check.
//                      Rendered as "coming soon" rather than a fake result.
const STATUS = { OK: "ok", ERROR: "error", NOT_CONFIGURED: "not_configured" };

async function timed(fn) {
  const start = Date.now();
  const result = await fn();
  return { result, latencyMs: Date.now() - start };
}

async function checkSupabase() {
  if (!supabaseAdmin) {
    return { name: "Supabase", status: STATUS.NOT_CONFIGURED, latencyMs: null, message: "Service role key not configured" };
  }

  try {
    const { latencyMs, result } = await timed(() =>
      supabaseAdmin.from("households").select("id", { count: "exact", head: true })
    );

    if (result.error) {
      return { name: "Supabase", status: STATUS.ERROR, latencyMs, message: result.error.message };
    }

    return { name: "Supabase", status: STATUS.OK, latencyMs, message: "Reachable" };
  } catch (err) {
    return { name: "Supabase", status: STATUS.ERROR, latencyMs: null, message: err.message };
  }
}

async function checkStripe() {
  if (!stripe) {
    return { name: "Stripe", status: STATUS.NOT_CONFIGURED, latencyMs: null, message: "Secret key not configured" };
  }

  try {
    const { latencyMs } = await timed(() => stripe.balance.retrieve());
    return { name: "Stripe", status: STATUS.OK, latencyMs, message: "Reachable" };
  } catch (err) {
    return { name: "Stripe", status: STATUS.ERROR, latencyMs: null, message: err.message };
  }
}

async function checkTwilio() {
  if (!twilioRestClient || !process.env.TWILIO_ACCOUNT_SID) {
    return { name: "Twilio", status: STATUS.NOT_CONFIGURED, latencyMs: null, message: "Account credentials not configured" };
  }

  try {
    const { latencyMs } = await timed(() =>
      twilioRestClient.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch()
    );
    return { name: "Twilio", status: STATUS.OK, latencyMs, message: "Reachable" };
  } catch (err) {
    return { name: "Twilio", status: STATUS.ERROR, latencyMs: null, message: err.message };
  }
}

async function checkOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    return { name: "OpenAI", status: STATUS.NOT_CONFIGURED, latencyMs: null, message: "API key not configured" };
  }

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const { latencyMs } = await timed(() => client.models.list());
    return { name: "OpenAI", status: STATUS.OK, latencyMs, message: "Reachable" };
  } catch (err) {
    return { name: "OpenAI", status: STATUS.ERROR, latencyMs: null, message: err.message };
  }
}

// No Resend (or any email provider) API key exists in this project's
// configuration today — transactional email currently goes through
// Supabase Auth's own built-in mailer, which has no separate health
// endpoint to check. Rather than invent a signal, this is reported as
// not configured until a dedicated email provider is wired in.
async function checkEmail() {
  return { name: "Email", status: STATUS.NOT_CONFIGURED, latencyMs: null, message: "No dedicated email provider configured" };
}

// No Railway API token exists in this project's configuration — hosting
// health (deploy status, uptime) is not queryable from the app itself
// without one. Reported as not configured rather than invented.
async function checkRailway() {
  return { name: "Railway", status: STATUS.NOT_CONFIGURED, latencyMs: null, message: "No Railway API token configured" };
}

async function getSystemHealth() {
  const [supabase, stripeHealth, twilio, openai, email, railway] = await Promise.all([
    checkSupabase(),
    checkStripe(),
    checkTwilio(),
    checkOpenAI(),
    checkEmail(),
    checkRailway(),
  ]);

  return [supabase, stripeHealth, twilio, openai, email, railway];
}

module.exports = { getSystemHealth, checkSupabase, checkStripe, checkTwilio, checkOpenAI, checkEmail, checkRailway, STATUS };
