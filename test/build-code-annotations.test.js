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

**The Problem:**
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
  assert.match(result.annotations[0].text, /\[MULTIREVIEW-1\]/);
  assert.deepEqual(result.unmatched, [{ id: "MULTIREVIEW-2", severity: "LOW", title: "No match" }]);
});
