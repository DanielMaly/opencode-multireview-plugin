import test from "node:test";
import assert from "node:assert/strict";
import {
  blockedIntentIds,
  partitionActionable,
  parseReviewFindings,
  serializeReviewFindings,
} from "../assets/scripts/parse-review-findings.mjs";

test("parses valid and ignored findings including Wontfix and serializes them", () => {
  const markdown = `# Review

## Valid Findings

**[HIGH] Broken branch**

**Location & Proof:**
src/example.ts:10

\`\`\`ts
return broken;
\`\`\`

**The Problem:**
This fails.

## Ignored Findings

**[LOW] Intentional shape**

**Location & Proof:**
src/example.ts:20

**The Problem:**
Looks unusual.

**Wontfix: Existing API contract**
`;

  const parsed = parseReviewFindings(markdown);

  assert.equal(parsed.valid.length, 1);
  assert.equal(parsed.valid[0].id, "MULTIREVIEW-1");
  assert.equal(parsed.valid[0].severity, "HIGH");
  assert.equal(parsed.valid[0].category, "GENERAL");
  assert.equal(parsed.ignored.length, 1);
  assert.deepEqual(parsed.uncertainties, []);
  assert.equal(parsed.ignored[0].category, "GENERAL");
  assert.equal(parsed.ignored[0].wontfix, "Existing API contract");

  const serialized = serializeReviewFindings(parsed);
  assert.match(serialized, /## Valid Findings/);
  assert.match(serialized, /\*\*\[HIGH\] Broken branch\*\*/);
  assert.match(serialized, /\*\*Wontfix: Existing API contract\*\*/);
});

test("parses and serializes intent uncertainties and INTENT findings", () => {
  const markdown = `## Valid Findings

**[HIGH] [INTENT] Unsupported rule**

The implementation adds an unauthorized rule.

**[MEDIUM] [CORRECTNESS] Depends on clarification**

The behavior is blocked.

**Blocked by intent:** MULTIREVIEW-UNCERTAINTY-1, MULTIREVIEW-UNCERTAINTY-2

## Intent Uncertainties

**[UNCERTAINTY] Lost-supply behavior is unspecified**

**Observed evidence:**
The endpoint rejects Lost supplies.

**Missing or conflicting context:**
The supplied ticket does not authorize that rule.

**Clarification question:**
Should Lost supplies be rejected?

**[UNCERTAINTY] Retry policy is unclear**

**Observed evidence:**
The retry branch is enabled.

**Missing or conflicting context:**
No source describes retry limits.

**Clarification question:**
What retry limit should apply?

## Ignored Findings

_No ignored findings._
`;

  const parsed = parseReviewFindings(markdown);

  assert.equal(parsed.valid[0].category, "INTENT");
  assert.deepEqual(blockedIntentIds(parsed.valid[1]), [
    "MULTIREVIEW-UNCERTAINTY-1",
    "MULTIREVIEW-UNCERTAINTY-2",
  ]);
  assert.deepEqual(parsed.uncertainties, [
    {
      id: "MULTIREVIEW-UNCERTAINTY-1",
      title: "Lost-supply behavior is unspecified",
      observedEvidence: "The endpoint rejects Lost supplies.",
      missingOrConflictingContext: "The supplied ticket does not authorize that rule.",
      clarificationQuestion: "Should Lost supplies be rejected?",
    },
    {
      id: "MULTIREVIEW-UNCERTAINTY-2",
      title: "Retry policy is unclear",
      observedEvidence: "The retry branch is enabled.",
      missingOrConflictingContext: "No source describes retry limits.",
      clarificationQuestion: "What retry limit should apply?",
    },
  ]);

  const serialized = serializeReviewFindings(parsed);
  assert.match(serialized, /## Intent Uncertainties/);
  assert.match(serialized, /\*\*\[UNCERTAINTY\] Retry policy is unclear\*\*/);
  assert.match(serialized, /\*\*Blocked by intent:\*\* MULTIREVIEW-UNCERTAINTY-1, MULTIREVIEW-UNCERTAINTY-2/);
});

test("partitions only valid findings into actionable and blocked wrappers", () => {
  assert.deepEqual(
    partitionActionable({
      valid: [
        { id: "MULTIREVIEW-1", body: "Independent" },
        {
          id: "MULTIREVIEW-2",
          body: "Depends on intent.\n\n**Blocked by intent:** MULTIREVIEW-UNCERTAINTY-1",
        },
      ],
      uncertainties: [{ id: "MULTIREVIEW-UNCERTAINTY-1" }],
      ignored: [{ id: "IGNORED-1" }],
    }),
    {
      actionable: [{ id: "MULTIREVIEW-1" }],
      blocked: [
        {
          finding: { id: "MULTIREVIEW-2" },
          uncertaintyIds: ["MULTIREVIEW-UNCERTAINTY-1"],
        },
      ],
    }
  );
});

test("excludes malformed uncertainty entries instead of creating canonical objects", () => {
  const markdown = `## Intent Uncertainties

**[UNCERTAINTY] Valid entry**

**Observed evidence:**
Observed.

**Missing or conflicting context:**
Missing.

**Clarification question:**
Question?

**[UNCERTAINTY] Out of order labels**

**Missing or conflicting context:**
Missing.

**Observed evidence:**
Observed.

**Clarification question:**
Question?

**[UNCERTAINTY] Empty field**

**Observed evidence:**

**Missing or conflicting context:**
Missing.

**Clarification question:**
Question?

**[UNCERTAINTY] Missing label**

**Observed evidence:**
Observed.

**Clarification question:**
Question?

**[UNCERTAINTY] Text before labels**

Unlabelled evidence.

**Observed evidence:**
Observed.

**Missing or conflicting context:**
Missing.

**Clarification question:**
Question?

## Ignored Findings

_No ignored findings._
`;

  const parsed = parseReviewFindings(markdown);

  assert.deepEqual(parsed.uncertainties, [
    {
      id: "MULTIREVIEW-UNCERTAINTY-1",
      title: "Valid entry",
      observedEvidence: "Observed.",
      missingOrConflictingContext: "Missing.",
      clarificationQuestion: "Question?",
    },
  ]);
});

test("accepts only the exact trailing blocked marker grammar", () => {
  const canonical = "Body.\n\n**Blocked by intent:** MULTIREVIEW-UNCERTAINTY-1, MULTIREVIEW-UNCERTAINTY-2";
  const cases = [
    { body: "Independent body.", expected: [] },
    { body: "Body.\n**Blocked by intent:** MULTIREVIEW-UNCERTAINTY-1", expected: [] },
    { body: "Body.\n\n**Blocked by intent:** MULTIREVIEW-UNCERTAINTY-1\nMore text.", expected: [] },
    { body: "Body.\n\n**Blocked by intent:** MULTIREVIEW-UNCERTAINTY-1,MULTIREVIEW-UNCERTAINTY-2", expected: [] },
    { body: "Body.\n\n**Blocked by intent:** MULTIREVIEW-UNCERTAINTY-1, MULTIREVIEW-OTHER-2", expected: [] },
    { body: "**Blocked by intent:** MULTIREVIEW-UNCERTAINTY-1", expected: [] },
  ];

  assert.deepEqual(blockedIntentIds({ body: canonical }), [
    "MULTIREVIEW-UNCERTAINTY-1",
    "MULTIREVIEW-UNCERTAINTY-2",
  ]);
  for (const { body, expected } of cases) {
    assert.deepEqual(blockedIntentIds({ body }), expected, body);
  }
});

test("parses a category tag in finding headings", () => {
  const markdown = `## Valid Findings

**[HIGH] [CORRECTNESS] Broken branch**

The body.

## Ignored Findings

**[LOW] [CODESTYLE] Formatting issue**

Style body.
`;

  const parsed = parseReviewFindings(markdown);

  assert.equal(parsed.valid[0].severity, "HIGH");
  assert.equal(parsed.valid[0].category, "CORRECTNESS");
  assert.equal(parsed.valid[0].title, "Broken branch");
  assert.equal(parsed.ignored[0].category, "CODESTYLE");
  assert.equal(parsed.ignored[0].title, "Formatting issue");
});

test("defaults legacy headings without a category to GENERAL", () => {
  const markdown = `## Valid Findings

**[MEDIUM] Missing test**

The body.

## Ignored Findings

_No ignored findings._
`;

  const parsed = parseReviewFindings(markdown);

  assert.equal(parsed.valid[0].category, "GENERAL");
  assert.equal(parsed.valid[0].title, "Missing test");
  assert.match(parsed.valid[0].raw, /\*\*\[MEDIUM\] Missing test\*\*/);
  assert.doesNotMatch(parsed.valid[0].raw, /\[GENERAL\]/);
});

test("serializes category headings while omitting GENERAL", () => {
  const findings = {
    valid: [
      {
        id: "MULTIREVIEW-1",
        severity: "HIGH",
        category: "TESTING",
        title: "Missing coverage",
        body: "Add a regression test.",
      },
      {
        id: "MULTIREVIEW-2",
        severity: "LOW",
        category: "GENERAL",
        title: "General note",
        body: "Note body.",
      },
    ],
    ignored: [],
  };

  const serialized = serializeReviewFindings(findings);

  assert.match(serialized, /\*\*\[HIGH\] \[TESTING\] Missing coverage\*\*/);
  assert.match(serialized, /\*\*\[LOW\] General note\*\*/);
  assert.doesNotMatch(serialized, /\[GENERAL\] General note/);
});
