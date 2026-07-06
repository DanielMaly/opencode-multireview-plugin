#!/usr/bin/env node
/**
 * Parse / serialize REVIEW_FINDINGS.md (as produced by @multireview) into a
 * stable JSON shape, and back again.
 *
 * REVIEW_FINDINGS.md contract (see ai-catalyst pkg/agents/shared/multireview*.md):
 *   ## Valid Findings
 *   **[SEVERITY] Title**
 *   ...verbatim body (Location & Proof, The Problem, etc)...
 *
 *   ## Ignored Findings
 *   **[SEVERITY] Title**
 *   ...verbatim body...
 *   **Wontfix: <reason>**
 *
 * Findings are split on a `**[SEVERITY] Title**` heading line. Everything
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
const HEADING_RE = new RegExp(
  `^\\*\\*\\[(${SEVERITIES.join("|")})\\]\\s*(.+?)\\*\\*\\s*$`
);
const WONTFIX_RE = /^\*\*Wontfix:\s*(.+?)\*\*\s*$/i;

function splitSections(markdown) {
  const lines = markdown.split(/\r?\n/);
  const sections = { valid: [], ignored: [] };
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
    if (/^##\s/.test(line)) {
      current = null;
      continue;
    }
    if (current) sections[current].push(line);
  }
  return sections;
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
      current = { severity: heading[1], title: heading[2].trim(), body: [], wontfix: null };
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
  const heading = `**[${finding.severity}] ${finding.title}**`;
  return [heading, "", ...finding.body].join("\n").trim();
}

export function parseReviewFindings(markdown) {
  const sections = splitSections(markdown);
  const valid = splitFindings(sections.valid).map((f, i) => ({
    id: `MULTIREVIEW-${i + 1}`,
    severity: f.severity,
    title: f.title,
    body: f.body.join("\n").trim(),
    raw: findingRaw(f),
  }));
  const ignored = splitFindings(sections.ignored)
    .map(extractWontfix)
    .map((f) => ({
      severity: f.severity,
      title: f.title,
      body: f.body.join("\n").trim(),
      wontfix: f.wontfix,
      raw: findingRaw(f),
    }));

  return { valid, ignored };
}

export function serializeReviewFindings({ valid, ignored }) {
  const validBlock = valid.length
    ? valid.map((f) => f.raw).join("\n\n")
    : "_No valid findings._";
  const ignoredBlock = ignored.length
    ? ignored
        .map((f) => {
          const wontfixLine = f.wontfix ? `\n\n**Wontfix: ${f.wontfix}**` : "";
          return `${f.raw}${wontfixLine}`;
        })
        .join("\n\n")
    : "_No ignored findings._";

  return `## Valid Findings\n\n${validBlock}\n\n## Ignored Findings\n\n${ignoredBlock}\n`;
}

// ── CLI ──────────────────────────────────────────────────────────────────

function main() {
  const [, , cmd, path] = process.argv;
  if (!cmd || !path) {
    console.error(
      "Usage:\n  parse-review-findings.mjs parse <REVIEW_FINDINGS.md>\n  parse-review-findings.mjs serialize <findings.json>"
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

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
