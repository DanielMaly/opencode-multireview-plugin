import test from "node:test";
import assert from "node:assert/strict";
import { buildCodeAnnotations } from "../assets/scripts/build-code-annotations.mjs";

test("maps a finding proof line to a unified diff line and reports unmatched findings", () => {
  const findings = {
    valid: [
      {
        id: "MULTIREVIEW-1",
        severity: "HIGH",
        title: "Throws on valid input",
        body: `**Location & Proof:**

\`\`\`ts
return parse(value);
\`\`\`

**The Problem**
The parser now throws.`,
      },
      {
        id: "MULTIREVIEW-2",
        severity: "LOW",
        title: "No match",
        body: `\`\`\`ts
missing();
\`\`\``,
      },
    ],
    uncertainties: [{ id: "MULTIREVIEW-UNCERTAINTY-1" }],
    ignored: [],
  };
  const diff = `diff --git a/src/parser.ts b/src/parser.ts
--- a/src/parser.ts
+++ b/src/parser.ts
@@ -8,3 +8,4 @@ export function run(value) {
 const before = true;
+return parse(value);
 }
`;

  const result = buildCodeAnnotations(findings, diff);

  assert.equal(result.annotations.length, 1);
  assert.equal(result.annotations[0].filePath, "src/parser.ts");
  assert.equal(result.annotations[0].lineStart, 9);
  assert.equal(result.annotations[0].source, "multireview");
  assert.match(result.annotations[0].text, /\[MULTIREVIEW-1\]/);
  assert.match(result.annotations[0].text, /The parser now throws\./);
  assert.doesNotMatch(result.annotations[0].text, /Location & Proof/);
  assert.doesNotMatch(result.annotations[0].text, /return parse\(value\);/);
  assert.deepEqual(result.unmatched, [{ id: "MULTIREVIEW-2", severity: "LOW", title: "No match" }]);
});

test("annotates blocked valid findings but never annotates uncertainties", () => {
  const findings = {
    valid: [
      {
        id: "MULTIREVIEW-5",
        severity: "HIGH",
        title: "Blocked but reviewable",
        body: `**Location & Proof:**

\`\`\`ts
return parse(value);
\`\`\`

**Blocked by intent:** MULTIREVIEW-UNCERTAINTY-1`,
      },
    ],
    uncertainties: [
      {
        id: "MULTIREVIEW-UNCERTAINTY-1",
        title: "Unclear rule",
        observedEvidence: "Observed.",
        missingOrConflictingContext: "Missing.",
        clarificationQuestion: "Which rule?",
      },
    ],
    ignored: [],
  };
  const diff = `diff --git a/src/parser.ts b/src/parser.ts
--- a/src/parser.ts
+++ b/src/parser.ts
@@ -8,3 +8,4 @@ export function run(value) {
 const before = true;
+return parse(value);
 }
`;

  const result = buildCodeAnnotations(findings, diff);

  assert.equal(result.annotations.length, 1);
  assert.match(result.annotations[0].text, /Blocked by intent/);
  assert.doesNotMatch(result.annotations[0].text, /Which rule\?/);
  assert.equal(result.unmatched.length, 0);
});

test("matches line-number-prefixed proof lines to the correct diff line", () => {
  const findings = {
    valid: [
      {
        id: "MULTIREVIEW-3",
        severity: "HIGH",
        title: "Missing dispatch config",
        body: `**Location & Proof:**

\`\`\`ts
253: \tif (!reconcile.dispatch) {
\`\`\`

**The Problem**: The dispatch branch can no longer run.`,
      },
    ],
    ignored: [],
  };
  const diff = `diff --git a/src/options.ts b/src/options.ts
--- a/src/options.ts
+++ b/src/options.ts
@@ -148,7 +148,7 @@ function buildOptions(options) {
 const retry = {
+  ...options.retry,
 };
@@ -250,7 +250,7 @@ function configure(reconcile) {
 const ready = true;
+if (!reconcile.dispatch) {
   return;
 }
`;

  const result = buildCodeAnnotations(findings, diff);

  assert.equal(result.annotations.length, 1);
  assert.equal(result.annotations[0].filePath, "src/options.ts");
  assert.equal(result.annotations[0].lineStart, 251);
  assert.equal(result.annotations[0].source, "multireview");
  assert.equal(result.unmatched.length, 0);
  assert.match(result.annotations[0].text, /The dispatch branch can no longer run\./);
  assert.doesNotMatch(result.annotations[0].text, /Location & Proof/);
  assert.doesNotMatch(result.annotations[0].text, /253:/);
});

test("ignores bare ellipsis proof candidates instead of anchoring to spread syntax", () => {
  const findings = {
    valid: [
      {
        id: "MULTIREVIEW-4",
        severity: "MEDIUM",
        title: "Missing Solax config",
        body: `**Location & Proof:**

\`\`\`ts
...
271: \tif (!options.solaxConfig) {
}
\`\`\`

**The Problem**: Without Solax config this exits incorrectly.`,
      },
    ],
    ignored: [],
  };
  const diff = `diff --git a/src/options.ts b/src/options.ts
--- a/src/options.ts
+++ b/src/options.ts
@@ -148,7 +148,7 @@ function buildOptions(options) {
 const retry = {
+  ...options.retry,
 };
@@ -268,7 +268,7 @@ function configure(options) {
 const ready = true;
+if (!options.solaxConfig) {
   return;
 }
`;

  const result = buildCodeAnnotations(findings, diff);

  assert.equal(result.annotations.length, 1);
  assert.equal(result.annotations[0].filePath, "src/options.ts");
  assert.equal(result.annotations[0].lineStart, 269);
  assert.notEqual(result.annotations[0].lineStart, 149);
  assert.match(result.annotations[0].text, /Without Solax config this exits incorrectly\./);
  assert.doesNotMatch(result.annotations[0].text, /Location & Proof/);
  assert.doesNotMatch(result.annotations[0].text, /\.\.\./);
  assert.equal(result.unmatched.length, 0);
});
