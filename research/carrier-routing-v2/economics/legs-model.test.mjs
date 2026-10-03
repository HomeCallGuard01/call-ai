import { test } from "node:test";
import assert from "node:assert/strict";
import { ARCHITECTURES, RATES, callCost, summarise, trustedMonthlyCost, loadRates } from "./legs-model.mjs";

test("reproduces the decision report's 10k-subscriber illustrations for today's architecture", () => {
  const a = ARCHITECTURES.A1_twilio_cfu;
  const at = (m) => Math.round(trustedMonthlyCost(a, { minutesPerSub: m, subs: 10000 }).gbp);
  assert.equal(at(100), 7560);
  assert.equal(at(200), 15120);
  assert.equal(at(400), 30240);
});

test("measured real trusted call: 239 s billed as 4 started minutes", () => {
  const c = callCost(ARCHITECTURES.A1_twilio_cfu.trusted, 239 / 60);
  assert.equal(c.gbp.toFixed(5), (4 * 0.00756).toFixed(5));
});

test("handset- and core-decided architectures carry no trusted legs", () => {
  for (const id of ["A3_A4_handset_cfb_app", "A3_A4_handset_cfb_byoc", "A12_handset_cfb_dialback", "A7_A9_core_signalling_only", "A10_mno_hook"]) {
    const s = summarise(ARCHITECTURES[id]);
    assert.equal(s.trustedEntersHcg, false, id);
    assert.equal(s.trustedChargeableLegs, 0, id);
    assert.equal(s.trustedPerMin, 0, id);
  }
});

test("moving legs is not removing them: A2 and A11 still bill every trusted minute", () => {
  assert.ok(summarise(ARCHITECTURES.A11_sip_edge_cfu).trustedChargeableLegs >= 2);
  const a2 = summarise(ARCHITECTURES.A2_telnyx_cfu);
  assert.ok(a2.trustedChargeableLegs >= 3);
  assert.ok(a2.trustedPerMin > 0);
});

test("unknown rates are surfaced, never silently zero", () => {
  const s = summarise(ARCHITECTURES.A9_core_media_anchored);
  assert.deepEqual(s.trustedMissing, ["fmcAnchoredLegPerMin"]);
  assert.ok(s.unknownMissing.includes("carrierSipEgressPerMin"));
  assert.ok(s.fixedMissing.includes("perSimMonthly"));
});

test("a quote can be inserted through an override file", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "legs-"));
  const p = join(dir, "q.json");
  writeFileSync(p, JSON.stringify({ fmcAnchoredLegPerMin: { gbp: 0.003, source: "test quote" } }));
  const rates = loadRates(p);
  const s = summarise(ARCHITECTURES.A9_core_media_anchored, rates);
  assert.deepEqual(s.trustedMissing, []);
  assert.equal(s.trustedPerMin.toFixed(4), "0.0030");
  assert.equal(RATES.fmcAnchoredLegPerMin.gbp, null, "defaults are not mutated");
});

test("override rejects unknown keys and negative rates", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "legs-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ notARate: 1 }));
  assert.throws(() => loadRates(bad), /Unknown rate key/);
  writeFileSync(bad, JSON.stringify({ sipInboundPerMin: -1 }));
  assert.throws(() => loadRates(bad), /non-negative/);
});
