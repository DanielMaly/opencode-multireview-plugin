#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const createdAt = Date.now();

function usage() {
  console.error(
    "Usage: node build-code-annotations.mjs --findings <findings.json> --diff <diff.patch> --out <code-annotations.json>"
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || !value) usage();
    args[key.slice(2)] = value;
  }

  for (const required of ["findings", "diff", "out"]) {
    if (!args[required]) usage();
  }
  return args;
}

function pathFromPatch(patch) {
  const plusPlus = /^\+\+\+\s+(?!\/dev\/null)(?:b\/)?(.+)$/m.exec(patch);
  if (plusPlus) return plusPlus[1].trim();
  const minusMinus = /^---\s+(?!\/dev\/null)(?:a\/)?(.+)$/m.exec(patch);
  if (minusMinus) return minusMinus[1].trim();
  const header = /^diff --git\s+a\/(.+?)\s+b\/(.+)$/m.exec(patch);
  return header ? header[2].trim() : "unknown";
}

export function parseDiff(diffText) {
  const headers = [...diffText.matchAll(/^diff --git\s+.*$/gm)];
  if (headers.length === 0 && diffText.trim()) {
    return [buildFilePatch(diffText.trim())];
  }

  return headers.map((match, index) => {
    const start = match.index;
    const end = index + 1 < headers.length ? headers[index + 1].index : diffText.length;
    return buildFilePatch(diffText.slice(start, end).trimEnd());
  });
}

function buildFilePatch(patch) {
  const path = pathFromPatch(patch);
  const badge = /(?:^|\n)new file mode\s+/m.test(patch)
    ? "NEW"
    : /(?:^|\n)deleted file mode\s+/m.test(patch)
      ? "DEL"
      : "MOD";
  let additions = 0;
  let deletions = 0;

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    if (line.startsWith("-")) deletions++;
  }

  return { path, patch, badge, additions, deletions };
}

function extractCandidateLines(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  const candidates = [];
  let inFence = false;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence || !trimmed) continue;
    if (trimmed.startsWith("//") || trimmed.startsWith("#")) continue;

    const candidate = trimmed.replace(/^\d+:\s*/, "").trim();
    if (!candidate || candidate === "...") continue;
    if (candidate.length < 8) continue;
    if (/^[^\p{L}\p{N}_]+$/u.test(candidate)) continue;

    candidates.push(candidate);
  }

  return [...new Set(candidates)].sort((a, b) => b.length - a.length);
}

function explanation(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  const problemIndex = lines.findIndex((line) => /^\*\*The Problem\*\*(?::\s*(.*))?$/i.test(line.trim()));
  if (problemIndex === -1) return lines.join("\n").trim();

  const problemMatch = /^\*\*The Problem\*\*(?::\s*(.*))?$/i.exec(lines[problemIndex].trim());
  const inlineText = problemMatch?.[1]?.trim();
  const selected = inlineText ? [inlineText, ...lines.slice(problemIndex + 1)] : lines.slice(problemIndex + 1);
  return selected.join("\n").trim();
}

export function matchFindingToFile(finding, files) {
  const candidates = extractCandidateLines(finding.body);

  for (const needle of candidates) {
    for (const file of files) {
      const line = findLineInPatch(file.patch, needle);
      if (line !== undefined) return { file, line };
    }
  }

  return { file: null, line: null };
}

function findLineInPatch(patch, needle) {
  const lines = patch.split(/\r?\n/);
  let newLine = null;
  let inHunk = false;

  for (const line of lines) {
    const hunk = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("@@")) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      const current = newLine;
      if (line.slice(1).includes(needle)) return current;
      newLine++;
      continue;
    }

    if (line.startsWith(" ")) {
      const current = newLine;
      if (line.slice(1).includes(needle)) return current;
      newLine++;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) continue;
    if (line.startsWith("\\")) continue;
  }

  return undefined;
}

function randomId() {
  return Math.random().toString(36).substring(2, 9);
}

export function buildAnnotation(finding, file, line) {
  const explanationText = explanation(finding.body);
  return {
    id: randomId(),
    type: "comment",
    source: "multireview",
    scope: "line",
    filePath: file.path,
    lineStart: line,
    lineEnd: line,
    side: "new",
    text: `[${finding.id}] [${finding.severity}] ${finding.title}\n\n${explanationText}`,
    createdAt,
    author: "multireview",
  };
}

export function buildCodeAnnotations(findings, diffText) {
  const files = parseDiff(diffText);
  const annotations = [];
  const unmatched = [];

  for (const finding of findings.valid) {
    const { file, line } = matchFindingToFile(finding, files);
    if (file && line) {
      annotations.push(buildAnnotation(finding, file, line));
    } else {
      unmatched.push({ id: finding.id, severity: finding.severity, title: finding.title });
    }
  }

  return { files, annotations, unmatched };
}

function main() {
  const args = parseArgs(process.argv);
  const findings = JSON.parse(readFileSync(args.findings, "utf8"));
  const diffText = readFileSync(args.diff, "utf8");
  const { files, annotations, unmatched } = buildCodeAnnotations(findings, diffText);

  writeFileSync(args.out, JSON.stringify(annotations, null, 2) + "\n", "utf8");

  console.error(
    `${files.length} files, ${annotations.length}/${findings.valid.length} valid findings placed (${unmatched.length} unmatched), ${findings.ignored.length} ignored`
  );
  process.stdout.write(JSON.stringify(unmatched, null, 2) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
