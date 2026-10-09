// Support-verified forwarding proof (migration 075, launch blocker B3,
// 2026-10-09). Thin wrapper over the two database functions, which re-check
// every evidence rule themselves — this module only reads candidates for the
// admin page and translates refusals. Full phone numbers never leave the
// server: callers get the last 4 digits only.

const REFUSAL_PREFIX = "forwarding_proof: ";

function last4(n) {
  const d = String(n || "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : null;
}

function phoneKey(n) {
  const d = String(n || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

// Designated support phones (HCG_SUPPORT_VERIFICATION_CALLERS, comma separated,
// E.164). Invalid entries are dropped; an empty list means the action is off.
function parseSupportCallers(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\+44\d{10}$/.test(s));
}

// A refusal raised by the database function → a clean 409 message.
function refusalMessage(err) {
  const msg = err && typeof err.message === "string" ? err.message : "";
  const i = msg.indexOf(REFUSAL_PREFIX);
  return i >= 0 ? msg.slice(i + REFUSAL_PREFIX.length).trim() : null;
}

function createForwardingProofDb(supabase) {
  async function getState({ householdId, supportCallers, maxAgeMinutes, now = new Date() }) {
    const { data: h, error } = await supabase
      .from("households")
      .select("id, status, phone_number, twilio_number, twilio_provisioning_status, forwarding_proven_at, forwarding_proof_method")
      .eq("id", householdId)
      .maybeSingle();
    if (error) throw new Error(`household read failed: ${error.message}`);
    if (!h) return null;

    const since = new Date(now.getTime() - maxAgeMinutes * 60 * 1000).toISOString();
    const { data: calls, error: callsErr } = await supabase
      .from("calls")
      .select("call_sid, number, created_at, dial_call_status")
      .eq("household_id", householdId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(20);
    if (callsErr) throw new Error(`calls read failed: ${callsErr.message}`);

    const { data: audit, error: auditErr } = await supabase
      .from("forwarding_proof_audit")
      .select("action, method, evidence_call_sid, evidence_call_at, evidence_caller_last4, attested_dialled_last4, hcg_number_last4, previous_proven_at, previous_method, reason, actor, at")
      .eq("household_id", householdId)
      .order("at", { ascending: false })
      .limit(20);
    if (auditErr) throw new Error(`audit read failed: ${auditErr.message}`);

    const supportKeys = new Set(supportCallers.map(phoneKey).filter(Boolean));
    const candidates = (calls || []).map((c) => {
      const fromSupport = supportKeys.has(phoneKey(c.number));
      const answered = c.dial_call_status === "completed";
      return {
        callSid: c.call_sid,
        at: c.created_at,
        callerLast4: last4(c.number),
        dialCallStatus: c.dial_call_status || null,
        fromSupportPhone: fromSupport,
        eligible: fromSupport && answered,
        why: !fromSupport ? "not from a designated support phone" : !answered ? "not answered in the app" : null,
      };
    });

    return {
      household: {
        id: h.id,
        status: h.status,
        mobileLast4: last4(h.phone_number),
        hcgNumberLast4: last4(h.twilio_number),
        numberActive: !!h.twilio_number && h.twilio_provisioning_status === "active",
        forwardingProvenAt: h.forwarding_proven_at || null,
        forwardingProofMethod: h.forwarding_proof_method || null,
      },
      maxAgeMinutes,
      supportPhonesConfigured: supportCallers.length,
      candidates,
      audit: audit || [],
    };
  }

  async function recordSupportProof({ householdId, evidenceCallSid, dialledLast4, supportCallers, reason, actor, maxAgeMinutes }) {
    const { data, error } = await supabase.rpc("hcg_record_support_forwarding_proof", {
      p_household_id: householdId,
      p_evidence_call_sid: evidenceCallSid,
      p_attested_dialled_last4: dialledLast4,
      p_support_caller_numbers: supportCallers,
      p_reason: reason,
      p_actor: actor,
      p_max_age_minutes: maxAgeMinutes,
    });
    if (error) throw Object.assign(new Error(error.message), { refusal: refusalMessage(error) });
    return data;
  }

  async function clearProof({ householdId, reason, actor }) {
    const { data, error } = await supabase.rpc("hcg_clear_forwarding_proof", {
      p_household_id: householdId,
      p_reason: reason,
      p_actor: actor,
    });
    if (error) throw Object.assign(new Error(error.message), { refusal: refusalMessage(error) });
    return data;
  }

  return { getState, recordSupportProof, clearProof };
}

module.exports = { createForwardingProofDb, parseSupportCallers, refusalMessage, last4 };
