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
  assert.equal(parsed.ignored.length, 1);
  assert.equal(parsed.ignored[0].wontfix, "Existing API contract");

  const serialized = serializeReviewFindings(parsed);
  assert.match(serialized, /## Valid Findings/);
  assert.match(serialized, /\*\*\[HIGH\] Broken branch\*\*/);
  assert.match(serialized, /\*\*Wontfix: Existing API contract\*\*/);
});
