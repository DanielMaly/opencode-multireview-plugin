#!/usr/bin/env node
/**
 * Parse / serialize REVIEW_FINDINGS.md (as produced by @multireview) into a
 * stable JSON shape, and back again.
 *
 * REVIEW_FINDINGS.md contract (see ai-catalyst pkg/agents/shared/multireview*.md):
 *   ## Valid Findings
 *   **[SEVERITY] [CATEGORY] Title**
 *   ...verbatim body (Location & Proof, The Problem, etc)...
 *
 *   ## Intent Uncertainties
 *   **[UNCERTAINTY] Title**
 *   **Observed evidence:**
 *   ...markdown...
 *   **Missing or conflicting context:**
 *   ...markdown...
 *   **Clarification question:**
 *   ...markdown...
 *
 *   ## Ignored Findings
 *   **[SEVERITY] [CATEGORY] Title**
 *   ...verbatim body...
 *   **Wontfix: <reason>**
 *
 * Findings are split on a `**[SEVERITY] [CATEGORY] Title**` heading line. Everything
 * between one such heading and the next (or the next `##` section, or EOF)
 * belongs to that finding. A trailing `**Wontfix: ...**` line (Ignored
 * Findings only) is extracted separately and stripped from the body.
 *
 * Usage:
 *   node parse-review-findings.mjs parse <REVIEW_FINDINGS.md>        -> JSON on stdout
 *   node parse-review-findings.mjs serialize <findings.json>         -> markdown on stdout
 */

import { readFileSync } from "node:fs";

const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const CATEGORIES = ["CORRECTNESS", "CODESTYLE", "TESTING", "INTENT", "GENERAL"];
const HEADING_RE = new RegExp(
  `^\\*\\*\\[(${SEVERITIES.join("|")})\\](?:\\s+\\[(${CATEGORIES.join("|")})\\])?\\s*(.+?)\\*\\*\\s*$`
);
const UNCERTAINTY_HEADING_RE = /^\*\*\[UNCERTAINTY\]\s+(.+?)\*\*\s*$/;
const UNCERTAINTY_LABELS = [
  ["observedEvidence", "**Observed evidence:**"],
  ["missingOrConflictingContext", "**Missing or conflicting context:**"],
  ["clarificationQuestion", "**Clarification question:**"],
];
const WONTFIX_RE = /^\*\*Wontfix:\s*(.+?)\*\*\s*$/i;
const BLOCKED_INTENT_RE =
  /\n\n\*\*Blocked by intent:\*\* (MULTIREVIEW-UNCERTAINTY-\d+(?:, MULTIREVIEW-UNCERTAINTY-\d+)*)$/;

function splitSections(markdown) {
  const lines = markdown.split(/\r?\n/);
  const sections = { valid: [], uncertainties: [], ignored: [] };
  let current = null;

  for (const line of lines) {
    if (/^##\s*Valid Findings/i.test(line)) {
      current = "valid";
      continue;
    }
    if (/^##\s*Ignored Findings/i.test(line)) {
      current = "ignored";
      continue;
    }
    if (/^##\s*Intent Uncertainties/i.test(line)) {
      current = "uncertainties";
      continue;
    }
    if (/^##\s/.test(line)) {
      current = null;
      continue;
    }
    if (current) sections[current].push(line);
  }
  return sections;
}

function splitUncertainties(lines) {
  const entries = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    while (current.body.length && current.body[0].trim() === "") current.body.shift();
    while (current.body.length && current.body[current.body.length - 1].trim() === "") current.body.pop();
    entries.push(current);
    current = null;
  };

  for (const line of lines) {
    const heading = UNCERTAINTY_HEADING_RE.exec(line.trim());
    if (heading) {
      flush();
      current = { title: heading[1].trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  flush();

  const validEntries = entries
    .map((entry) => {
    const fields = Object.fromEntries(UNCERTAINTY_LABELS.map(([name]) => [name, []]));
    let active = -1;
    for (const line of entry.body) {
      const labelIndex = UNCERTAINTY_LABELS.findIndex(([, marker]) => line.trim() === marker);
      if (labelIndex !== -1) {
        if (labelIndex !== active + 1) return null;
        active = labelIndex;
        continue;
      }
      if (active === -1) return null;
      fields[UNCERTAINTY_LABELS[active][0]].push(line);
    }

    if (active !== UNCERTAINTY_LABELS.length - 1) return null;
    if (UNCERTAINTY_LABELS.some(([name]) => fields[name].join("\n").trim() === "")) return null;

    return {
      title: entry.title,
      observedEvidence: fields.observedEvidence.join("\n").trim(),
      missingOrConflictingContext: fields.missingOrConflictingContext.join("\n").trim(),
      clarificationQuestion: fields.clarificationQuestion.join("\n").trim(),
    };
    })
    .filter(Boolean);

  return validEntries.map((entry, index) => ({
    id: `MULTIREVIEW-UNCERTAINTY-${index + 1}`,
    ...entry,
  }));
}

function splitFindings(lines) {
  const findings = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    // Trim leading/trailing blank lines from the body.
    while (current.body.length && current.body[0].trim() === "") current.body.shift();
    while (current.body.length && current.body[current.body.length - 1].trim() === "")
      current.body.pop();
    findings.push(current);
  };

  for (const line of lines) {
    const heading = HEADING_RE.exec(line.trim());
    if (heading) {
      flush();
      current = {
        severity: heading[1],
        category: heading[2] ?? "GENERAL",
        title: heading[3].trim(),
        body: [],
        wontfix: null,
      };
      continue;
    }
    if (current) current.body.push(line);
  }
  flush();
  return findings;
}

function extractWontfix(finding) {
  const body = finding.body;
  for (let i = body.length - 1; i >= 0; i--) {
    const m = WONTFIX_RE.exec(body[i].trim());
    if (m) {
      finding.wontfix = m[1].trim();
      finding.body = [...body.slice(0, i), ...body.slice(i + 1)];
      // Re-trim trailing blanks left behind.
      while (finding.body.length && finding.body[finding.body.length - 1].trim() === "")
        finding.body.pop();
      return finding;
    }
  }
  return finding;
}

function findingRaw(finding) {
  const category = finding.category && finding.category !== "GENERAL" ? ` [${finding.category}]` : "";
  const heading = `**[${finding.severity}]${category} ${finding.title}**`;
  const body = Array.isArray(finding.body) ? finding.body : String(finding.body ?? "").split(/\r?\n/);
  return [heading, "", ...body].join("\n").trim();
}

export function parseReviewFindings(markdown) {
  const sections = splitSections(markdown);
  const valid = splitFindings(sections.valid).map((f, i) => ({
    id: `MULTIREVIEW-${i + 1}`,
    severity: f.severity,
    category: f.category,
    title: f.title,
    body: f.body.join("\n").trim(),
    raw: findingRaw(f),
  }));
  const ignored = splitFindings(sections.ignored)
    .map(extractWontfix)
    .map((f) => ({
      severity: f.severity,
      category: f.category,
      title: f.title,
      body: f.body.join("\n").trim(),
      wontfix: f.wontfix,
      raw: findingRaw(f),
    }));
  const uncertainties = splitUncertainties(sections.uncertainties);

  return { valid, uncertainties, ignored };
}

function uncertaintyRaw(uncertainty) {
  return [
    `**[UNCERTAINTY] ${uncertainty.title}**`,
    "",
    "**Observed evidence:**",
    uncertainty.observedEvidence,
    "",
    "**Missing or conflicting context:**",
    uncertainty.missingOrConflictingContext,
    "",
    "**Clarification question:**",
    uncertainty.clarificationQuestion,
  ].join("\n");
}

export function serializeReviewFindings({ valid, uncertainties, ignored }) {
  const validBlock = valid.length
    ? valid.map((f) => f.raw ?? findingRaw(f)).join("\n\n")
    : "_No valid findings._";
  const uncertaintyBlock = uncertainties?.length
    ? uncertainties.map(uncertaintyRaw).join("\n\n")
    : "_No intent uncertainties._";
  const ignoredBlock = ignored.length
    ? ignored
        .map((f) => {
          const wontfixLine = f.wontfix ? `\n\n**Wontfix: ${f.wontfix}**` : "";
          return `${f.raw ?? findingRaw(f)}${wontfixLine}`;
        })
        .join("\n\n")
    : "_No ignored findings._";

  return `## Valid Findings\n\n${validBlock}\n\n## Intent Uncertainties\n\n${uncertaintyBlock}\n\n## Ignored Findings\n\n${ignoredBlock}\n`;
}

export function blockedIntentIds(finding) {
  const body = String(finding?.body ?? "").replaceAll("\r\n", "\n");
  const match = BLOCKED_INTENT_RE.exec(body);
  return match ? match[1].split(", ") : [];
}

export function partitionActionable(findings) {
  const actionable = [];
  const blocked = [];

  for (const finding of findings.valid ?? []) {
    const uncertaintyIds = blockedIntentIds(finding);
    if (uncertaintyIds.length) {
      blocked.push({ finding: { id: finding.id }, uncertaintyIds });
    } else {
      actionable.push({ id: finding.id });
    }
  }

  return { actionable, blocked };
}

// ── CLI ──────────────────────────────────────────────────────────────────

function main() {
  const [, , cmd, path] = process.argv;
  if (!cmd || !path) {
    console.error(
      "Usage:\n  parse-review-findings.mjs parse <REVIEW_FINDINGS.md>\n  parse-review-findings.mjs serialize <findings.json>\n  parse-review-findings.mjs partition-actionable <findings.json>"
    );
    process.exit(1);
  }

  if (cmd === "parse") {
    const markdown = readFileSync(path, "utf-8");
    process.stdout.write(JSON.stringify(parseReviewFindings(markdown), null, 2) + "\n");
    return;
  }

  if (cmd === "serialize") {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    process.stdout.write(serializeReviewFindings(data));
    return;
  }

  if (cmd === "partition-actionable") {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    process.stdout.write(JSON.stringify(partitionActionable(data), null, 2) + "\n");
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
