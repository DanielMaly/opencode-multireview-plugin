import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFinding, normalizeRoundPayload } from "../dist/findings.js";

test("normalizes finding text and source-agent boundaries", () => {
  const finding = normalizeFinding({
    disposition: "valid",
    severity: "HIGH",
    category: "TESTING",
    title: "  Title\r\n",
    bodyMarkdown: " Body\rLine ",
    sourceAgents: [" testing ", "correctness", "testing"],
  });
  assert.equal(finding.title, "Title");
  assert.equal(finding.bodyMarkdown, "Body\nLine");
  assert.deepEqual(finding.sourceAgents, ["correctness", "testing"]);
  assert.deepEqual(finding.blockedByUncertaintyIds, []);
});

test("enforces finding and blocker validation boundaries", () => {
  assert.throws(() => normalizeFinding({ ...valid(), severity: "BLOCKER" }), /severity is invalid/);
  assert.throws(() => normalizeFinding({ ...valid(), category: "GENERAL" }), /category is invalid/);
  assert.throws(() => normalizeFinding({ ...valid(), sourceAgents: [] }), /sourceAgents must contain/);
  assert.throws(() => normalizeFinding({ ...valid(), wontfix: "reason" }), /valid findings cannot have wontfix/);
  assert.throws(() => normalizeFinding({ ...valid(), disposition: "ignored" }), /ignored findings require wontfix/);
  assert.throws(() => normalizeRoundPayload([valid({ blockedByUncertaintyIds: ["1"] })]), /unknown uncertainty 1/);
  assert.throws(() => normalizeRoundPayload([], [], [{ title: "", observedEvidence: "e", missingContext: "m", clarificationQuestion: "q" }]), /uncertainty title/);
});

function valid(overrides = {}) {
  return {
    disposition: "valid",
    severity: "LOW",
    category: "CORRECTNESS",
    title: "Title",
    bodyMarkdown: "Body",
    sourceAgents: ["agent"],
    ...overrides,
  };
}
