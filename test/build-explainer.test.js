import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPatchSnippet,
  groupFindingsByCategory,
  paragraphs,
  renderHtml,
  sanitizeDiagramHtml,
} from "../assets/scripts/build-explainer.mjs";

test("markdown-lite renderer contract: escapes HTML and renders inline/block markdown", () => {
  const rendered = paragraphs(`Plain <script>alert(1)</script> and \`code\` and **bold**

- one
- two

\`\`\`js
if (value < 1) alert("x");
\`\`\``);

  assert.doesNotMatch(rendered, /<script>/);
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(rendered, /<code>code<\/code>/);
  assert.match(rendered, /<strong>bold<\/strong>/);
  assert.match(rendered, /<ul>.*<li>one<\/li>.*<li>two<\/li>.*<\/ul>/s);
  assert.match(rendered, /class="code-panel"|<pre><code>/);
  assert.match(rendered, /if \(value &lt; 1\) alert\(&quot;x&quot;\);/);
});

test("markdown-lite renderer strips null sentinels and preserves mixed intro lists", () => {
  const rendered = paragraphs(`Intro with \u0000CODE9\u0000 and \`real code\`
- one
- two`);

  assert.doesNotMatch(rendered, /undefined/);
  assert.doesNotMatch(rendered, /\u0000/);
  assert.match(rendered, /Intro with CODE9 and <code>real code<\/code><br><ul>/);
  assert.match(rendered, /<li>one<\/li>/);
  assert.match(rendered, /<li>two<\/li>/);
});

test("snippet extraction contract: returns exactly ±5 lines and marks matched line", () => {
  const patch = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,13 +1,13 @@
 line 1
 line 2
 line 3
 line 4
 line 5
+matched line 6
 line 7
 line 8
 line 9
 line 10
 line 11
 line 12
 line 13`;

  const snippetHtml = extractPatchSnippet(patch, { file: "src/example.ts", line: 6 });

  assert.match(snippetHtml, /line 1/);
  assert.match(snippetHtml, /line 11/);
  assert.doesNotMatch(snippetHtml, /line 12/);
  assert.match(snippetHtml, /<[^>]+class="[^"]*\bline-matched\b[^"]*"[^>]*>[^<]*matched line 6[^<]*<\/[^>]+>/);
  assert.doesNotMatch(snippetHtml, /<[^>]+class="[^"]*\bline-matched\b[^"]*"[^>]*>[^<]*line (?:1|2|3|4|5|7|8|9|10|11)[^<]*<\/[^>]+>/);
});

test("category bucketing contract: routes findings into five implementor-detail buckets", () => {
  const findings = [
    { category: "CORRECTNESS", title: "Correctness" },
    { category: "CODESTYLE", title: "Style" },
    { category: "TESTING", title: "Testing" },
    { category: "INTENT", title: "Intent" },
    { title: "Legacy" },
  ];

  assert.deepEqual(groupFindingsByCategory(findings), {
    CORRECTNESS: [findings[0]],
    CODESTYLE: [findings[1]],
    TESTING: [findings[2]],
    INTENT: [findings[3]],
    GENERAL: [findings[4]],
  });
});

test("explainer keeps blocked findings visible and renders uncertainties separately", () => {
  const html = renderHtml({
    manifest: { prTitle: "Intent review", repo: "example" },
    files: [],
    unmatchedValidFindings: [
      {
        id: "MULTIREVIEW-1",
        tag: "[MULTIREVIEW-1]",
        severity: "HIGH",
        title: "Blocked behavior",
        body: "Problem.\n\n**Blocked by intent:** MULTIREVIEW-UNCERTAINTY-1",
        explanation: "Problem.\n\n**Blocked by intent:** MULTIREVIEW-UNCERTAINTY-1",
        locationLabel: "general",
      },
    ],
    unmatchedIgnoredFindings: [],
    uncertainties: [
      {
        id: "MULTIREVIEW-UNCERTAINTY-1",
        title: "Rule is unclear",
        observedEvidence: "Observed.",
        missingOrConflictingContext: "Missing context.",
        clarificationQuestion: "Which rule applies?",
      },
    ],
  });

  assert.match(html, /<div class="bubble blocking blocked">/);
  assert.match(html, /<span class="blocked-label">Blocked by intent<\/span>/);
  assert.match(html, /Intent uncertainties/);
  assert.match(html, /Observed evidence/);
  assert.match(html, /Which rule applies\?/);
  assert.match(html, /Intent review/);
});

test("sanitizeDiagramHtml contract: strips active SVG/HTML attack surface", () => {
  const unsafe = `<svg onclick="evil()" onload="evil()"><script>alert(1)</script><foreignObject><p>x</p></foreignObject><a href="javascript:alert(1)" xlink:href="data:text/html,<script>alert(1)</script>"><rect width="10" height="10"></rect></a></svg>`;

  const sanitized = sanitizeDiagramHtml(unsafe);

  assert.doesNotMatch(sanitized, /<script/i);
  assert.doesNotMatch(sanitized, /<a\b/i);
  assert.doesNotMatch(sanitized, /onclick=/i);
  assert.doesNotMatch(sanitized, /onload=/i);
  assert.doesNotMatch(sanitized, /<foreignObject/i);
  assert.doesNotMatch(sanitized, /javascript:/i);
  assert.doesNotMatch(sanitized, /data:/i);

  const benign = sanitizeDiagramHtml(`<svg><rect width="10" height="10"></rect></svg>`);

  assert.match(benign, /<svg\b/i);
  assert.match(benign, /<rect\b/i);
  assert.doesNotMatch(benign, /<script/i);
  assert.doesNotMatch(benign, /on(?:click|load)=/i);
  assert.doesNotMatch(benign, /<foreignObject/i);
  assert.doesNotMatch(benign, /(?:javascript|data):/i);
});

test("sanitizeDiagramHtml strips SVG sanitizer bypasses", () => {
  const sanitized = sanitizeDiagramHtml(
    `<svg/onload=alert(1)><rect href="javascript&#58;alert(1)"></rect><set attributeName="onload" to="alert(1)"></set><style>rect{background:url(javascript:alert(1))}</style><animate></animate></svg>`
  );

  assert.match(sanitized, /<svg\b/i);
  assert.match(sanitized, /<rect\b/i);
  assert.doesNotMatch(sanitized, /onload=/i);
  assert.doesNotMatch(sanitized, /href=/i);
  assert.doesNotMatch(sanitized, /javascript/i);
  assert.doesNotMatch(sanitized, /<set\b/i);
  assert.doesNotMatch(sanitized, /<style\b/i);
  assert.doesNotMatch(sanitized, /<animate\b/i);
});
