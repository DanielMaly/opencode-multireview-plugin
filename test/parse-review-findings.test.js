import test from "node:test";
import assert from "node:assert/strict";
import {
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
  assert.equal(parsed.ignored[0].category, "GENERAL");
  assert.equal(parsed.ignored[0].wontfix, "Existing API contract");

  const serialized = serializeReviewFindings(parsed);
  assert.match(serialized, /## Valid Findings/);
  assert.match(serialized, /\*\*\[HIGH\] Broken branch\*\*/);
  assert.match(serialized, /\*\*Wontfix: Existing API contract\*\*/);
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
