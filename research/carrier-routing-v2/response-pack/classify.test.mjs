import { test } from "node:test";
import assert from "node:assert/strict";
import { template, classify, renderMarkdown } from "./classify.mjs";

const set = (t, provider, id, answer, excerpt = "pasted") => {
  t[provider].questions[id].answer = answer;
  t[provider].questions[id].excerpt = excerpt;
  return t;
};

test("blank template: POC 1 still needed, everything unconfirmed, all commercial data missing", () => {
  const r = classify(template());
  assert.equal(r.poc1.verdict, "STILL NEEDED");
  assert.ok(r.rows.every((x) => x.status.startsWith("Not confirmed")));
  assert.ok(r.missingCommercial.AQL.includes("perSimMonthly"));
  assert.ok(r.simRoutes.every((s) => !s.confirmed));
});

test("expected aql answer (applies only to aql SIMs) does not remove POC 1", () => {
  const r = classify(set(template(), "AQL", "AQL-1", "NO"));
  assert.equal(r.poc1.verdict, "STILL NEEDED");
  assert.equal(r.rows.find((x) => x.id === "AQL-1").status, "Ruled out");
});

test("aql YES to routing for subscribers on other networks removes POC 1", () => {
  const r = classify(set(template(), "AQL", "AQL-1", "YES"));
  assert.equal(r.poc1.verdict, "NOT NEEDED");
});

test("Twilio naming a real upstream arrangement removes POC 1", () => {
  assert.equal(classify(set(template(), "TWILIO", "TWI-1", "yes")).poc1.verdict, "NOT NEEDED");
});

test("one MNO hook removes POC 1 only for that network; all three removes it", () => {
  let t = set(template(), "EE", "MNO-1", "YES");
  let r = classify(t);
  assert.equal(r.poc1.verdict, "STILL NEEDED");
  assert.match(r.poc1.why, /EE/);
  t = set(set(t, "VMO2", "MNO-1", "YES"), "VODAFONETHREE", "MNO-1", "YES");
  assert.equal(classify(t).poc1.verdict, "NOT NEEDED");
});

test("a fully confirmed SIM route makes POC 1 optional for SIM-switch customers only", () => {
  let t = template();
  for (const id of ["AQL-2", "AQL-3", "AQL-4", "AQL-5", "AQL-6"]) t = set(t, "AQL", id, "YES");
  const r = classify(t);
  assert.equal(r.poc1.verdict, "STILL NEEDED");
  assert.match(r.poc1.why, /optional for customers who accept a SIM switch/);
  assert.ok(r.simRoutes.find((s) => s.label.startsWith("aql")).confirmed);
});

test("a NO on porting blocks the SIM route", () => {
  let t = template();
  for (const id of ["AQL-2", "AQL-3", "AQL-5", "AQL-6"]) t = set(t, "AQL", id, "YES");
  t = set(t, "AQL", "AQL-4", "NO");
  const s = classify(t).simRoutes.find((x) => x.label.startsWith("aql"));
  assert.equal(s.confirmed, false);
  assert.deepEqual(s.blocked, ["AQL-4"]);
});

test("network-behaviour answers narrow but never remove POC 1", () => {
  const r = classify(set(template(), "VODAFONETHREE", "MNO-2", "YES"));
  assert.equal(r.poc1.verdict, "STILL NEEDED");
  assert.match(r.poc1.why, /narrow/);
});

test("invalid answers are reported, not guessed", () => {
  const r = classify(set(template(), "TELNYX", "TEL-1", "maybe"));
  assert.equal(r.problems.length, 1);
});

test("markdown renders a follow-up marked as draft", () => {
  const md = renderMarkdown(classify(template()));
  assert.match(md, /Follow-up \(draft, not sent\)/);
  assert.match(md, /POC 1: STILL NEEDED/);
});
