#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

function usage() {
  console.error(
    "Usage: node build-explainer.mjs --findings <findings.json> --diff <diff.patch> --manifest <manifest.json> --out <output.html>"
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  const allowed = new Set(["findings", "diff", "manifest", "out"]);
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    const name = key?.slice(2);
    if (!key?.startsWith("--") || !value || !allowed.has(name)) usage();
    args[name] = value;
  }

  for (const required of allowed) {
    if (!args[required]) usage();
  }
  return args;
}

function html(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function slug(value) {
  const safe = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `file-${safe || "changed"}`;
}

function pathFromPatch(patch) {
  const plusPlus = /^\+\+\+\s+(?!\/dev\/null)(?:b\/)?(.+)$/m.exec(patch);
  if (plusPlus) return plusPlus[1].trim();
  const minusMinus = /^---\s+(?!\/dev\/null)(?:a\/)?(.+)$/m.exec(patch);
  if (minusMinus) return minusMinus[1].trim();
  const header = /^diff --git\s+a\/(.+?)\s+b\/(.+)$/m.exec(patch);
  return header ? header[2].trim() : "unknown";
}

function parseDiff(diffText) {
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

  return { path, patch, badge, additions, deletions, id: slug(path), risk: "safe" };
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
    candidates.push(trimmed);
  }

  return candidates;
}

function explanation(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  const problemIndex = lines.findIndex((line) => /^\*\*The Problem:\*\*\s*$/i.test(line.trim()));
  const selected = problemIndex === -1 ? lines : lines.slice(problemIndex + 1);
  return selected.join("\n").trim();
}

function matchFindingToFile(finding, files) {
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

function riskForSeverity(severity) {
  if (["CRITICAL", "HIGH"].includes(severity)) return "attention";
  if (severity === "MEDIUM") return "medium";
  return "safe";
}

function bubbleClass(severity) {
  if (["CRITICAL", "HIGH"].includes(severity)) return "blocking";
  if (severity === "MEDIUM") return "nit";
  return "suggestion";
}

function higherRisk(current, next) {
  const rank = { safe: 0, medium: 1, attention: 2 };
  return rank[next] > rank[current] ? next : current;
}

function paragraphs(text) {
  return String(text ?? "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => html(part).replace(/\n/g, "<br>"))
    .join("<br><br>");
}

function renderFinding(item, { dismissed = false, includeLocation = true } = {}) {
  const location = item.locationHref
    ? `<a class="anchor" href="#${item.locationHref}">${html(item.locationLabel)}</a>`
    : `<span class="anchor">${html(item.locationLabel)}</span>`;
  const wontfix = item.wontfix ? `<p><strong>Wontfix:</strong> ${paragraphs(item.wontfix)}</p>` : "";
  const locationMarkup = includeLocation ? `<span class="anchor">${location}</span>` : "";

  return `<div class="bubble ${bubbleClass(item.severity)}${dismissed ? " dismissed" : ""}">
    <span class="anchor">${html(item.tag)}</span>
    <span class="severity">${html(item.severity)}</span>
    ${locationMarkup}
    <p><strong class="bubble-title">${html(item.title)}</strong>${item.explanation ? ` — ${paragraphs(item.explanation)}` : ""}</p>
    ${wontfix}
  </div>`;
}

function renderDiffBlock(file) {
  const patchId = `${file.id}-patch`;
  const patchJson = JSON.stringify(file.patch).replaceAll("</", "<\\/");

  return `<div class="diff-block">
    <script type="application/json" id="${patchId}">${patchJson}</script>
    <diffs-container data-patch-id="${patchId}"></diffs-container>
  </div>`;
}

function renderComments(validFindings, ignoredFindings, options = {}) {
  const bubbles = [
    ...validFindings.map((finding) => renderFinding(finding, options)),
    ...ignoredFindings.map((finding) => renderFinding(finding, { ...options, dismissed: true })),
  ];

  return bubbles.length ? `<div class="comments">${bubbles.join("\n")}</div>` : "";
}

function renderFindingList(validFindings, ignoredFindings, options = {}) {
  return [
    ...validFindings.map((finding) => renderFinding(finding, options)),
    ...ignoredFindings.map((finding) => renderFinding(finding, { ...options, dismissed: true })),
  ].join("\n");
}

function renderFile(file, manifest) {
  const why = manifest.fileNotes?.[file.path];
  const badgeClass = file.badge.toLowerCase();
  const head = `<div class="file-head">
    <div class="file-info">
      <span class="file-path">${html(file.path)}</span>
      <span class="file-badge ${badgeClass}">${file.badge}</span>
      <span class="file-stats"><span class="additions">+${file.additions}</span> <span class="deletions">-${file.deletions}</span></span>
    </div>
    <span class="risk-tag ${file.risk}">${file.risk}</span>
  </div>`;
  const whyBlock = why ? `<div class="file-why"><p>${paragraphs(why)}</p></div>` : "";
  const body = `${whyBlock}
  ${renderDiffBlock(file)}
  ${renderComments(file.validFindings ?? [], file.ignoredFindings ?? [])}`;

  if (file.risk === "safe") {
    return `<details class="file-collapsed" id="${file.id}">
  <summary>
    <span class="file-path">${html(file.path)}</span>
    <span class="file-badge ${badgeClass}">${file.badge}</span>
    <span class="file-stats"><span class="additions">+${file.additions}</span> <span class="deletions">-${file.deletions}</span></span>
    <span class="risk-tag ${file.risk}">${file.risk}</span>
  </summary>
  ${body}
</details>`;
  }

  return `<div class="file-card" id="${file.id}">
  ${head}
  ${body}
</div>`;
}

function renderGeneralFindings(number, validFindings, ignoredFindings) {
  if (validFindings.length === 0 && ignoredFindings.length === 0) return "";

  return `<section>
  <div class="section-header"><span class="section-number">${number}</span><h2>General findings</h2></div>
  <div class="finding-list">
    ${renderFindingList(validFindings, ignoredFindings, { includeLocation: false })}
  </div>
</section>`;
}

function renderFocusItems(number, items) {
  if (!Array.isArray(items) || items.length === 0) return "";
  return `<section>
  <div class="section-header"><span class="section-number">${number}</span><h2>Where to focus</h2></div>
  <div class="focus-list">
    ${items
      .map(
        (item, index) => `<div class="focus-item">
      <span class="focus-number">${index + 1}</span>
      <div><strong>${html(item.file ?? "Review focus")}</strong><p>${paragraphs(item.note ?? "")}</p></div>
    </div>`
      )
      .join("\n")}
  </div>
</section>`;
}

function renderTestPlan(number, items) {
  if (!Array.isArray(items) || items.length === 0) return "";
  return `<section>
  <div class="section-header"><span class="section-number">${number}</span><h2>Test plan</h2></div>
  <div class="test-list">
    ${items
      .map(
        (item) => `<div class="test-item${item.done ? " done" : ""}"><span class="check"></span><span>${paragraphs(item.text ?? "")}</span></div>`
      )
      .join("\n")}
  </div>
</section>`;
}

function renderTldr(tldr) {
  if (!tldr) return "";
  return `<div class="tldr"><h3>TL;DR</h3><p>${paragraphs(tldr)}</p></div>`;
}

function renderWhy(number, why) {
  if (!why?.before && !why?.after) return "";
  return `<section>
      <div class="section-header"><span class="section-number">${number}</span><h2>Why</h2></div>
      <div class="before-after">
        <div class="ba-panel before"><h4>Before</h4><p>${paragraphs(why?.before || "")}</p></div>
        <div class="ba-panel after"><h4>After</h4><p>${paragraphs(why?.after || "")}</p></div>
      </div>
    </section>`;
}

function renderHtml({ manifest, files, unmatchedValidFindings, unmatchedIgnoredFindings }) {
  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const sections = {};
  let nextSection = 1;
  if (manifest.why?.before || manifest.why?.after) {
    sections.why = String(nextSection++).padStart(2, "0");
  }
  sections.files = String(nextSection++).padStart(2, "0");
  if (unmatchedValidFindings.length || unmatchedIgnoredFindings.length) {
    sections.general = String(nextSection++).padStart(2, "0");
  }
  sections.risk = String(nextSection++).padStart(2, "0");
  sections.focus = String(nextSection++).padStart(2, "0");
  sections.test = String(nextSection++).padStart(2, "0");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${html(manifest.prTitle || "PR explainer")}</title>
  <script type="module">
    import { getSingularPatch, registerDiffsComponent } from 'https://cdn.jsdelivr.net/npm/@pierre/diffs@1.1.21/+esm';
    registerDiffsComponent();

    document.querySelectorAll('diffs-container[data-patch-id]').forEach((container) => {
      const patchElement = document.getElementById(container.dataset.patchId);
      if (!patchElement) return;

      const patch = JSON.parse(patchElement.textContent);
      container.fileDiff = getSingularPatch(patch);
      container.options = {
        themeType: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        diffStyle: 'unified',
        diffIndicators: 'bars',
        lineDiffType: 'word-alt',
        unsafeCSS: \`
          :host {
            --diffs-bg: var(--background);
            --diffs-fg: var(--foreground);
            border-radius: var(--radius);
            border: 1.5px solid var(--border);
            overflow: hidden;
          }
        \`,
      };
    });
  </script>
  <style>
:root {
  --background: oklch(0.97 0.005 260);
  --foreground: oklch(0.18 0.02 260);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.18 0.02 260);
  --primary: oklch(0.50 0.25 280);
  --primary-foreground: oklch(1 0 0);
  --secondary: oklch(0.50 0.18 180);
  --secondary-foreground: oklch(1 0 0);
  --muted: oklch(0.92 0.01 260);
  --muted-foreground: oklch(0.40 0.02 260);
  --accent: oklch(0.60 0.22 50);
  --accent-foreground: oklch(0.18 0.02 260);
  --destructive: oklch(0.50 0.25 25);
  --destructive-foreground: oklch(1 0 0);
  --success: oklch(0.45 0.20 150);
  --success-foreground: oklch(1 0 0);
  --warning: oklch(0.55 0.18 85);
  --warning-foreground: oklch(0.18 0.02 260);
  --border: oklch(0.88 0.01 260);
  --input: oklch(0.92 0.01 260);
  --ring: oklch(0.50 0.25 280);
  --code-bg: oklch(0.92 0.01 260);

  --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
  --font-display: ui-serif, Georgia, 'Times New Roman', serif;
  --radius: 0.625rem;
}

*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: var(--font-sans);
  background: var(--background);
  color: var(--foreground);
  line-height: 1.65;
  font-size: 15px;
  -webkit-font-smoothing: antialiased;
}

.container {
  max-width: 1080px;
  margin: 0 auto;
  padding: 64px 24px;
}

.eyebrow {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted-foreground);
}

header h1 {
  font-family: var(--font-display);
  font-size: 2rem;
  font-weight: 500;
  margin: 8px 0 24px;
  line-height: 1.2;
}

section { margin-top: 64px; }

.section-header {
  display: flex;
  align-items: baseline;
  gap: 16px;
  margin-bottom: 24px;
  padding-bottom: 8px;
  border-bottom: 1.5px solid var(--border);
}

.section-number {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--primary);
}

.section-header h2 {
  font-family: var(--font-display);
  font-size: 1.4rem;
  font-weight: 500;
}

details {
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  margin: 16px 0;
}

summary {
  font-family: var(--font-sans);
  font-weight: 500;
  padding: 16px 24px;
  cursor: pointer;
  list-style: none;
}

summary::before {
  content: '▸';
  display: inline-block;
  margin-right: 8px;
  transition: transform 0.2s;
}

details[open] summary::before { transform: rotate(90deg); }

.details-body { padding: 0 24px 24px; }

.pr-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--muted-foreground);
  margin-top: 8px;
}

.pr-meta .additions { color: var(--success); }
.pr-meta .deletions { color: var(--destructive); }

.tldr {
  background: var(--card);
  border: 1.5px solid var(--border);
  border-left: 4px solid var(--primary);
  border-radius: var(--radius);
  padding: 20px 24px;
  max-width: 760px;
  margin: 24px 0;
}

.tldr h3 {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--primary);
  margin-bottom: 8px;
}

.tldr p {
  font-size: 0.95rem;
  line-height: 1.6;
  color: var(--muted-foreground);
}

.comments {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  background: var(--muted);
  border-top: 1px solid var(--border);
}

.finding-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.finding-list .bubble {
  max-width: 860px;
}

.finding-list .bubble::before {
  content: none;
}

.finding-list .bubble .anchor + .anchor {
  margin-left: 8px;
}

.empty-state {
  color: var(--muted-foreground);
  font-size: 0.9rem;
}

.bubble {
  position: relative;
  background: var(--card);
  border: 1.5px solid var(--border);
  border-left-width: 4px;
  border-radius: 8px;
  padding: 12px 14px 12px 16px;
  max-width: 680px;
}

.bubble.blocking { border-left-color: var(--primary); }
.bubble.nit { border-left-color: var(--border); }
.bubble.suggestion { border-left-color: var(--success); }

.bubble.dismissed {
  border-left-color: var(--muted-foreground);
  opacity: 0.65;
}

.bubble.dismissed::before {
  border-left-color: var(--muted-foreground);
  border-bottom-color: var(--muted-foreground);
}

.bubble.dismissed .bubble-title {
  text-decoration: line-through;
}

.bubble::before {
  content: "";
  position: absolute;
  left: -9px;
  top: 16px;
  width: 12px;
  height: 12px;
  background: var(--card);
  border-left: 1.5px solid var(--border);
  border-bottom: 1.5px solid var(--border);
  transform: rotate(45deg);
}

.bubble.blocking::before {
  border-left-color: var(--primary);
  border-bottom-color: var(--primary);
}

.anchor {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--muted-foreground);
}

.severity {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-left: 8px;
}

.bubble.blocking .severity { color: var(--primary); }
.bubble.nit .severity { color: var(--muted-foreground); }
.bubble.suggestion .severity { color: var(--success); }

.bubble p {
  margin-top: 6px;
  font-size: 0.88rem;
  line-height: 1.55;
  color: var(--foreground);
}

.diff-block {
  background: var(--background);
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
}

diffs-container {
  display: block;
  border-radius: var(--radius);
  overflow: hidden;
}

.bubble code {
  font-family: var(--font-mono);
  font-size: 0.82rem;
  background: var(--muted);
  padding: 1px 5px;
  border-radius: 3px;
}

.risk-map {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 24px 0;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  padding: 6px 12px;
  border: 1.5px solid var(--border);
  border-radius: 20px;
  text-decoration: none;
  color: var(--foreground);
  transition: box-shadow 0.15s;
}

.chip:hover {
  box-shadow: 0 0 0 2px color-mix(in oklab, var(--primary) 25%, transparent);
}

.chip .dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}

.chip.attention {
  background: color-mix(in oklab, var(--destructive) 8%, transparent);
  border-color: color-mix(in oklab, var(--destructive) 40%, transparent);
}
.chip.attention .dot { background: var(--destructive); }

.chip.medium {
  background: color-mix(in oklab, var(--warning) 10%, transparent);
  border-color: color-mix(in oklab, var(--warning) 30%, transparent);
}
.chip.medium .dot { background: var(--warning); }

.chip.safe {
  background: color-mix(in oklab, var(--success) 8%, transparent);
  border-color: color-mix(in oklab, var(--success) 35%, transparent);
}
.chip.safe .dot { background: var(--success); }

.file-card {
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  overflow: hidden;
  scroll-margin-top: 20px;
  margin: 16px 0;
}

.file-head {
  padding: 16px 20px;
  border-bottom: 1.5px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.file-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.file-path {
  font-family: var(--font-mono);
  font-size: 0.82rem;
  font-weight: 600;
}

.file-stats {
  font-family: var(--font-mono);
  font-size: 0.72rem;
}

.file-stats .additions { color: var(--success); }
.file-stats .deletions { color: var(--destructive); }

.file-why {
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
}

.file-why p {
  font-size: 0.9rem;
  color: var(--muted-foreground);
  line-height: 1.55;
}

.file-collapsed {
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  margin: 8px 0;
}

.file-collapsed summary {
  list-style: none;
  cursor: pointer;
  padding: 14px 20px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.file-collapsed summary::before {
  content: none;
  display: none;
}

.file-collapsed summary::after {
  content: '+';
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--muted-foreground);
  margin-left: auto;
}

.file-collapsed[open] summary::after {
  content: '\\2212';
}

.before-after {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin: 16px 0;
}

@media (max-width: 640px) {
  .before-after { grid-template-columns: 1fr; }
}

.ba-panel {
  background: var(--card);
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 20px;
}

.ba-panel.after {
  border-color: var(--success);
}

.ba-panel h4 {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 8px;
}

.ba-panel.before h4 { color: var(--muted-foreground); }
.ba-panel.after h4 { color: var(--success); }

.ba-panel p {
  font-size: 0.9rem;
  line-height: 1.55;
  color: var(--foreground);
}

.focus-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 16px 0;
}

.focus-item {
  background: var(--card);
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 20px;
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.focus-number {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--primary-foreground);
  background: var(--primary);
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.focus-item strong {
  font-family: var(--font-mono);
  font-size: 0.82rem;
  display: block;
  margin-bottom: 4px;
}

.focus-item p {
  font-size: 0.88rem;
  color: var(--muted-foreground);
  line-height: 1.5;
}

.test-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 16px 0;
}

.test-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  background: var(--card);
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  padding: 13px 18px;
  font-size: 0.88rem;
}

.check {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  border: 1.5px solid var(--border);
  flex-shrink: 0;
  position: relative;
  margin-top: 2px;
}

.test-item.done .check {
  background: var(--success);
  border-color: var(--success);
}

.test-item.done .check::after {
  content: '';
  position: absolute;
  left: 5px;
  top: 2px;
  width: 5px;
  height: 9px;
  border-right: 2px solid var(--card);
  border-bottom: 2px solid var(--card);
  transform: rotate(40deg);
}

.file-badge {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: calc(var(--radius) - 4px);
}

.file-badge.new {
  background: color-mix(in oklab, var(--success) 15%, transparent);
  color: var(--success);
}

.file-badge.mod {
  background: color-mix(in oklab, var(--warning) 15%, transparent);
  color: var(--warning);
}

.file-badge.del {
  background: color-mix(in oklab, var(--destructive) 15%, transparent);
  color: var(--destructive);
}

.risk-tag {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 3px 8px;
  border-radius: calc(var(--radius) - 4px);
}

.risk-tag.attention {
  background: color-mix(in oklab, var(--destructive) 12%, transparent);
  color: var(--destructive);
}

.risk-tag.medium {
  background: color-mix(in oklab, var(--warning) 12%, transparent);
  color: var(--warning);
}

.risk-tag.safe {
  background: color-mix(in oklab, var(--success) 12%, transparent);
  color: var(--success);
}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <span class="eyebrow">Pull request · ${html(manifest.repo || "repository")}</span>
      <h1>${html(manifest.prTitle || "PR explainer")}</h1>
      <div class="pr-meta">
        <span>${files.length} files</span>
        <span class="additions">+${totalAdditions}</span>
        <span class="deletions">-${totalDeletions}</span>
        <span>${html(manifest.branch || "branch")}</span>
      </div>
    </header>

    ${renderTldr(manifest.tldr)}

    ${renderWhy(sections.why, manifest.why)}

    <section>
      <div class="section-header"><span class="section-number">${sections.files}</span><h2>File tour</h2></div>
      ${files.map((file) => renderFile(file, manifest)).join("\n")}
    </section>

    ${renderGeneralFindings(sections.general, unmatchedValidFindings, unmatchedIgnoredFindings)}

    <section>
      <div class="section-header"><span class="section-number">${sections.risk}</span><h2>Risk map</h2></div>
      <div class="risk-map">
        ${files.map((file) => `<a href="#${file.id}" class="chip ${file.risk}"><span class="dot"></span>${html(file.path)}</a>`).join("\n")}
      </div>
    </section>

    ${renderFocusItems(sections.focus, manifest.focusItems)}
    ${renderTestPlan(sections.test, manifest.testPlan)}
  </div>
</body>
</html>
`;
}

function main() {
  const args = parseArgs(process.argv);
  const findings = JSON.parse(readFileSync(args.findings, "utf8"));
  const diffText = readFileSync(args.diff, "utf8");
  const manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
  const files = parseDiff(diffText);
  const unmatchedValidFindings = [];
  const unmatchedIgnoredFindings = [];

  for (const file of files) {
    file.validFindings = [];
    file.ignoredFindings = [];
  }

  for (const finding of findings.valid) {
    const { file, line } = matchFindingToFile(finding, files);
    const explanationText = explanation(finding.body);
    const locationLabel = file ? `${file.path}${line ? `:${line}` : ""}` : "general";
    const renderedFinding = {
      ...finding,
      tag: `[${finding.id}]`,
      explanation: explanationText,
      locationLabel,
      locationHref: file?.id ?? null,
    };

    if (file) {
      file.risk = higherRisk(file.risk, riskForSeverity(finding.severity));
      file.validFindings.push(renderedFinding);
    } else {
      unmatchedValidFindings.push(renderedFinding);
    }
  }

  findings.ignored.forEach((finding, index) => {
    const { file, line } = matchFindingToFile(finding, files);
    const locationLabel = file ? `${file.path}${line ? `:${line}` : ""}` : "general";
    const renderedFinding = {
      ...finding,
      tag: `[IGNORED-${index + 1}]`,
      explanation: explanation(finding.body),
      locationLabel,
      locationHref: file?.id ?? null,
    };

    if (file) {
      file.ignoredFindings.push(renderedFinding);
    } else {
      unmatchedIgnoredFindings.push(renderedFinding);
    }
  });

  writeFileSync(
    args.out,
    renderHtml({ manifest, files, unmatchedValidFindings, unmatchedIgnoredFindings }),
    "utf8"
  );

  const validAttached = files.reduce((sum, file) => sum + file.validFindings.length, 0);
  const ignoredAttached = files.reduce((sum, file) => sum + file.ignoredFindings.length, 0);
  console.error(
    `${files.length} files, ${validAttached}/${findings.valid.length} valid findings attached (${unmatchedValidFindings.length} general), ${ignoredAttached}/${findings.ignored.length} ignored attached (${unmatchedIgnoredFindings.length} general)`
  );
}

main();
