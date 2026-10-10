// twilioCredentials.js — PURE classification of the Twilio credentials the
// HCG runtime holds (Agent 1, 2026-10-11; containment design P6).
//
// No twilio client is constructed and nothing is printed: launchConfig and
// services/twilioClient.js both use this, and neither may ever log a value.
//
// What it answers:
//   restMode         'api_key' | 'auth_token' | 'none' — which credential the
//                    REST client (services/twilioClient.js) will actually use.
//   apiKeyIncomplete exactly one of TWILIO_API_KEY_SID / _SECRET is set: the
//                    client then SILENTLY falls back to the auth token.
//   apiKeyMalformed  TWILIO_API_KEY_SID is set but is not an SK… key SID.
//   runtimeIsParent  TWILIO_ACCOUNT_SID equals the declared parent
//                    (HCG_TWILIO_PARENT_ACCOUNT_SID): master credentials in
//                    the runtime.
//   parentDeclared   HCG_TWILIO_PARENT_ACCOUNT_SID is a well-formed AC… SID.
//   parentSecretKeys env keys that look like a parent/master SECRET (they
//                    must never be in the runtime; the parent's credentials
//                    live only in the Twilio Functions service).
//
// IMPORTANT (documented, not solvable here): TWILIO_AUTH_TOKEN stays in the
// runtime because Twilio signs webhooks with the owning account's auth token.
// With numbers in a subaccount that is the SUBACCOUNT's token — which is
// itself a full REST credential for that subaccount. Credential isolation
// therefore protects the PARENT account (other subaccounts, billing,
// settings, the breaker) from a backend compromise; it does NOT stop a
// compromised backend from using the runtime subaccount. See
// docs/launch/2026-10-11-AGENT1-CONTAINMENT-REPORT.md §4 (scenario c).
'use strict';

const present = (v) => typeof v === 'string' && v.trim() !== '';
const ACCOUNT_SID = /^AC[0-9a-f]{32}$/i;
const API_KEY_SID = /^SK[0-9a-f]{32}$/i;
const PARENT_SECRET_KEY = /^(HCG_)?TWILIO_(PARENT|MASTER|MAIN|ROOT)_[A-Z0-9_]*(TOKEN|SECRET)$|^(HCG_)?(PARENT|MASTER)_TWILIO_[A-Z0-9_]*(TOKEN|SECRET)$/;

function twilioRestCredentialMode(env = process.env) {
  if (!present(env.TWILIO_ACCOUNT_SID)) return 'none';
  if (present(env.TWILIO_API_KEY_SID) && present(env.TWILIO_API_KEY_SECRET)) return 'api_key';
  if (present(env.TWILIO_AUTH_TOKEN)) return 'auth_token';
  return 'none';
}

function classifyTwilioRuntimeCredentials(env = process.env) {
  const sid = present(env.TWILIO_ACCOUNT_SID) ? env.TWILIO_ACCOUNT_SID.trim() : null;
  const parent = present(env.HCG_TWILIO_PARENT_ACCOUNT_SID) ? env.HCG_TWILIO_PARENT_ACCOUNT_SID.trim() : null;
  const keySid = present(env.TWILIO_API_KEY_SID) ? env.TWILIO_API_KEY_SID.trim() : null;
  const keySecret = present(env.TWILIO_API_KEY_SECRET);
  return {
    restMode: twilioRestCredentialMode(env),
    apiKeyIncomplete: Boolean(keySid) !== keySecret,
    apiKeyMalformed: Boolean(keySid) && !API_KEY_SID.test(keySid),
    parentDeclared: Boolean(parent) && ACCOUNT_SID.test(parent),
    parentMalformed: Boolean(parent) && !ACCOUNT_SID.test(parent),
    runtimeIsParent: Boolean(sid && parent) && sid.toLowerCase() === parent.toLowerCase(),
    signingTokenPresent: present(env.TWILIO_AUTH_TOKEN),
    parentSecretKeys: Object.keys(env).filter((k) => PARENT_SECRET_KEY.test(k) && present(env[k])).sort(),
  };
}

module.exports = { twilioRestCredentialMode, classifyTwilioRuntimeCredentials, ACCOUNT_SID, API_KEY_SID, PARENT_SECRET_KEY };
