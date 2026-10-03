// Provider response pack classifier.
//
// Andrew pastes each provider reply into responses.json (an `excerpt` per
// question) and records the answer as YES / NO / PARTIAL / UNCLEAR. This script
// then reports, per question and overall:
//   - capability confirmed / not confirmed
//   - architectures affected
//   - whether POC 1 is still needed
//   - the drafted follow-up question (for Andrew to send; nothing is sent here)
//   - commercial data still missing
//
// Run:  node research/carrier-routing-v2/response-pack/classify.mjs --template > responses.json
//       node research/carrier-routing-v2/response-pack/classify.mjs responses.json
//
// It reads a local file and prints markdown. It makes no network calls.

import { readFileSync } from "node:fs";
import { PROVIDERS, NETWORK_KEYS, ANSWERS, SIM_ROUTE_BUNDLES } from "./rules.mjs";

export function template() {
  const t = { _instructions: "For each question set answer to YES, NO, PARTIAL, UNCLEAR or UNANSWERED and paste the provider's own words into excerpt. Fill commercial values as text with units (e.g. '£0.50/number/month at 1k'). Leave blank if not given." };
  for (const [key, p] of Object.entries(PROVIDERS)) {
    t[key] = { provider: p.name, replyDate: "", source: "", questions: {}, commercial: {} };
    for (const [id, q] of Object.entries(p.questions)) t[key].questions[id] = { q: q.q, answer: "UNANSWERED", excerpt: "" };
    for (const c of p.commercial) t[key].commercial[c] = "";
  }
  return t;
}

export function classify(responses) {
  const rows = [];
  const removes = [];
  const removesForNetwork = {};
  const narrows = [];
  const missingCommercial = {};
  const problems = [];

  for (const [key, p] of Object.entries(PROVIDERS)) {
    const r = responses[key] ?? { questions: {}, commercial: {} };
    for (const [id, q] of Object.entries(p.questions)) {
      const given = r.questions?.[id] ?? {};
      const answer = (given.answer ?? "UNANSWERED").toUpperCase();
      if (!ANSWERS.includes(answer)) {
        problems.push(`${key} ${id}: answer "${given.answer}" is not one of ${ANSWERS.join(", ")}`);
        continue;
      }
      const rule = q[answer];
      if (!rule) {
        rows.push({ provider: key, id, answer, status: answer === "UNCLEAR" ? "Not confirmed (unclear reply)" : "Not confirmed (no reply)", capability: "—", affects: [], poc1: "NONE", followUp: q.askAgain, excerpt: given.excerpt ?? "" });
        continue;
      }
      const status = answer === "YES" ? "Confirmed" : answer === "NO" ? "Ruled out" : "Partly confirmed";
      rows.push({ provider: key, id, answer, status, capability: rule.capability, affects: rule.affects, poc1: rule.poc1, followUp: rule.followUp, excerpt: given.excerpt ?? "" });
      if (rule.poc1 === "REMOVES") removes.push(`${key} ${id}`);
      if (rule.poc1 === "REMOVES_FOR_NETWORK") removesForNetwork[key] = `${key} ${id}`;
      if (rule.poc1 === "NARROWS") narrows.push(`${key} ${id} (${answer})`);
    }
    const missing = p.commercial.filter((c) => !String(r.commercial?.[c] ?? "").trim());
    if (missing.length) missingCommercial[key] = missing;
  }

  const answerOf = (provider, id) => (responses[provider]?.questions?.[id]?.answer ?? "UNANSWERED").toUpperCase();
  const simRoutes = Object.entries(SIM_ROUTE_BUNDLES).map(([label, b]) => {
    const states = b.all.map((id) => [id, answerOf(b.provider, id)]);
    const confirmed = states.every(([, a]) => a === "YES");
    const blocked = states.filter(([, a]) => a === "NO").map(([id]) => id);
    const open = states.filter(([, a]) => a !== "YES" && a !== "NO").map(([id]) => id);
    return { label, confirmed, blocked, open };
  });

  const networksRemoved = NETWORK_KEYS.filter((k) => removesForNetwork[k]);
  let poc1;
  if (removes.length) {
    poc1 = { verdict: "NOT NEEDED", why: `A provider confirmed caller-based routing without a SIM change (${removes.join(", ")}). Verify it with a provider-run trial on one SIM before abandoning POC 1 entirely.` };
  } else if (networksRemoved.length === NETWORK_KEYS.length) {
    poc1 = { verdict: "NOT NEEDED", why: "All three UK network groups confirmed a network-side hook (MNO-1). MVNOs on them still need checking." };
  } else {
    const parts = [];
    if (networksRemoved.length) parts.push(`not needed for subscribers of ${networksRemoved.join(", ")} (MNO-1 YES)`);
    const sim = simRoutes.filter((s) => s.confirmed).map((s) => s.label);
    if (sim.length) parts.push(`optional for customers who accept a SIM switch to ${sim.join(" or ")}`);
    if (narrows.length) parts.push(`network-behaviour answers narrow it (${narrows.join("; ")}) but the handset and Apple halves still need testing`);
    poc1 = { verdict: "STILL NEEDED", why: parts.length ? `Still needed for customers who keep their SIM; ${parts.join("; ")}.` : "No answer yet removes or narrows it." };
  }

  return { rows, poc1, simRoutes, missingCommercial, problems };
}

export function renderMarkdown(result) {
  const out = [];
  out.push(`# Provider response classification\n`);
  out.push(`**POC 1: ${result.poc1.verdict}.** ${result.poc1.why}\n`);
  if (result.problems.length) {
    out.push("## Input problems\n");
    for (const p of result.problems) out.push(`- ${p}`);
    out.push("");
  }
  out.push("## SIM-switch routes\n");
  out.push("| Route | Status | Blocked by | Still open |");
  out.push("|---|---|---|---|");
  for (const s of result.simRoutes) out.push(`| ${s.label} | ${s.confirmed ? "All conditions confirmed" : s.blocked.length ? "Blocked" : "Unconfirmed"} | ${s.blocked.join(", ") || "—"} | ${s.open.join(", ") || "—"} |`);
  out.push("");
  out.push("## Answers\n");
  out.push("| Provider | Q | Answer | Capability | Status | Architectures | POC 1 effect | Follow-up (draft, not sent) |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const r of result.rows) out.push(`| ${r.provider} | ${r.id} | ${r.answer} | ${r.capability} | ${r.status} | ${r.affects.join(", ") || "—"} | ${r.poc1} | ${r.followUp === "NONE" ? "—" : r.followUp} |`);
  out.push("");
  out.push("## Commercial data still missing\n");
  for (const [k, v] of Object.entries(result.missingCommercial)) out.push(`- **${k}:** ${v.join(", ")}`);
  return out.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  if (arg === "--template") {
    console.log(JSON.stringify(template(), null, 2));
  } else if (!arg) {
    console.error("Usage: classify.mjs --template | classify.mjs responses.json");
    process.exit(2);
  } else {
    console.log(renderMarkdown(classify(JSON.parse(readFileSync(arg, "utf8")))));
  }
}
