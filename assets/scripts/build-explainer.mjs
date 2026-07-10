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

export function matchFindingToFile(finding, files) {
  const candidates = extractCandidateLines(finding.body);

  for (const needle of candidates) {
    for (const file of files) {
      const match = findLineInPatch(file.patch, needle);
      if (match !== undefined) return { file, line: match.line, snippet: match.snippet };
    }
  }

  return { file: null, line: null, snippet: null };
}

export function findLineInPatch(patch, needle) {
  const parsed = parsePatchLines(patch);
  const match = parsed.find(
    (line) => line.newLine !== null && ["add", "context"].includes(line.kind) && line.text.includes(needle)
  );

  if (!match) return undefined;
  return { line: match.newLine, snippet: windowAroundLine(parsed, match.newLine) };
}

function parsePatchLines(patch) {
  const lines = patch.split(/\r?\n/);
  let newLine = null;
  let inHunk = false;
  const parsed = [];

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
      parsed.push({ newLine: current, text: line.slice(1), kind: "add" });
      newLine++;
      continue;
    }

    if (line.startsWith(" ")) {
      const current = newLine;
      parsed.push({ newLine: current, text: line.slice(1), kind: "context" });
      newLine++;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      parsed.push({ newLine: null, text: line.slice(1), kind: "del" });
      continue;
    }
    if (line.startsWith("\\")) continue;
  }

  return parsed;
}

function windowAroundLine(lines, matchedLine) {
  const matchedIndex = lines.findIndex((line) => line.newLine === matchedLine);
  if (matchedIndex === -1) return [];
  return lines
    .filter((line) => line.newLine !== null)
    .filter((line) => Math.abs(line.newLine - matchedLine) <= 5)
    .map((line) => ({ ...line, matched: line.newLine === matchedLine }));
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

function inlineMarkdown(text) {
  const code = [];
  const escaped = html(text).replaceAll("\u0000", "").replace(/`([^`]+)`/g, (_, value) => {
    code.push(`<code>${value}</code>`);
    return `\u0000CODE${code.length - 1}\u0000`;
  });
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\u0000CODE(\d+)\u0000/g, (match, index) => code[Number(index)] ?? match);
}

function renderMarkdownBlock(block) {
  const trimmed = block.trim();
  if (!trimmed) return "";

  const lines = trimmed.split(/\r?\n/);
  const firstBullet = lines.findIndex((line) => /^-\s+/.test(line.trim()));
  if (firstBullet !== -1) {
    const leading = lines.slice(0, firstBullet).join("\n").trim();
    const listItems = lines
      .slice(firstBullet)
      .filter((line) => /^-\s+/.test(line.trim()))
      .map((line) => `<li>${inlineMarkdown(line.trim().replace(/^-\s+/, ""))}</li>`)
      .join("");
    const paragraph = leading ? `${inlineMarkdown(leading).replace(/\n/g, "<br>")}<br>` : "";
    return `${paragraph}<ul>${listItems}</ul>`;
  }

  return inlineMarkdown(trimmed).replace(/\n/g, "<br>");
}

export function paragraphs(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const blocks = [];
  let buffer = [];
  let fence = null;
  let code = [];

  const flushBuffer = () => {
    const rendered = renderMarkdownBlock(buffer.join("\n"));
    if (rendered) blocks.push(rendered);
    buffer = [];
  };

  for (const line of lines) {
    const fenceStart = /^```(.*)$/.exec(line.trim());
    if (fenceStart) {
      if (fence !== null) {
        const label = fence ? `<span class="code-label">${html(fence)}</span>` : "";
        blocks.push(`<div class="code-panel">${label}<pre><code>${html(code.join("\n"))}</code></pre></div>`);
        fence = null;
        code = [];
      } else {
        flushBuffer();
        fence = fenceStart[1].trim();
      }
      continue;
    }

    if (fence !== null) {
      code.push(line);
      continue;
    }

    if (line.trim() === "") {
      flushBuffer();
      continue;
    }
    buffer.push(line);
  }

  if (fence !== null) {
    const label = fence ? `<span class="code-label">${html(fence)}</span>` : "";
    blocks.push(`<div class="code-panel">${label}<pre><code>${html(code.join("\n"))}</code></pre></div>`);
  }
  flushBuffer();

  return blocks.join("<br><br>");
}

export function extractPatchSnippet(diffText, location) {
  const files = parseDiff(diffText);
  const file = files.find((candidate) => candidate.path === location.file) ?? files[0];
  if (!file || !location.line) return "";
  return renderSnippet(windowAroundLine(parsePatchLines(file.patch), location.line));
}

function renderSnippet(snippet) {
  if (!Array.isArray(snippet) || snippet.length === 0) return "";
  const lines = snippet
    .map((line) => {
      const classes = [line.kind === "add" ? "add" : line.kind === "del" ? "del" : "line-context"];
      if (line.matched) classes.push("line-matched");
      const number = line.newLine === null ? "-" : String(line.newLine).padStart(4, " ");
      return `<span class="${classes.join(" ")}">${html(`${number} ${line.text}`)}</span>`;
    })
    .join("\n");
  return `<div class="code-panel snippet"><pre><code>${lines}</code></pre></div>`;
}

export function sanitizeDiagramHtml(input) {
  const allowedElements = new Set([
    "svg",
    "g",
    "rect",
    "circle",
    "ellipse",
    "line",
    "path",
    "polygon",
    "polyline",
    "text",
    "tspan",
    "defs",
    "marker",
    "title",
    "desc",
  ]);

  const decodeEntities = (value) =>
    value.replace(/&(?:#(\d+)|#x([\da-f]+)|colon|Tab|NewLine);?/gi, (match, decimal, hex) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      if (/colon/i.test(match)) return ":";
      return "";
    });

  return String(input ?? "")
    .replace(/<(script|foreignObject|style|set|animate|animateTransform|use)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<([a-z][\w:-]*)\b[^>]*>[\s\S]*?<\/\1>/gi, (element, name) =>
      allowedElements.has(name.toLowerCase()) ? element : ""
    )
    .replace(/<\/?([a-z][\w:-]*)\b[^>]*>/gi, (tag, name) => {
      if (!allowedElements.has(name.toLowerCase())) return "";
      return tag
        .replace(/([\s/]+)on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "$1")
        .replace(/([\s/]+)(?:href|xlink:href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (match, prefix, value) => {
          const unquoted = value.replace(/^(["'])([\s\S]*)\1$/, "$2");
          const normalized = decodeEntities(unquoted).replace(/[\u0000-\u0020]+/g, "").toLowerCase();
          return /^(?:javascript|data):/.test(normalized) ? prefix : match;
        });
    });
}

export function groupFindingsByCategory(findings) {
  const groups = { CORRECTNESS: [], CODESTYLE: [], TESTING: [], GENERAL: [] };
  for (const finding of findings) {
    const category = Object.hasOwn(groups, finding.category) ? finding.category : "GENERAL";
    groups[category].push(finding);
  }
  return groups;
}

export function renderFinding(item, { dismissed = false, includeLocation = true } = {}) {
  const location = item.locationHref
    ? `<a class="anchor" href="#${item.locationHref}">${html(item.locationLabel)}</a>`
    : `<span class="anchor">${html(item.locationLabel)}</span>`;
  const wontfix = item.wontfix ? `<p><strong>Wontfix:</strong> ${paragraphs(item.wontfix)}</p>` : "";
  const locationMarkup = includeLocation ? `<span class="anchor">${location}</span>` : "";
  const snippet = item.snippet ? renderSnippet(item.snippet) : "";

  return `<div class="bubble ${bubbleClass(item.severity)}${dismissed ? " dismissed" : ""}">
    <span class="anchor">${html(item.tag)}</span>
    <span class="severity">${html(item.severity)}</span>
    ${locationMarkup}
    ${snippet}
    <div class="finding-explanation"><strong class="bubble-title">${html(item.title)}</strong>${item.explanation ? ` — ${paragraphs(item.explanation)}` : ""}</div>
    ${wontfix}
  </div>`;
}

export function renderDiffBlock(file) {
  const patchId = `${file.id}-patch`;
  const patchJson = JSON.stringify(file.patch).replaceAll("</", "<\\/");

  return `<div class="diff-block">
    <script type="application/json" id="${patchId}">${patchJson}</script>
    <diffs-container data-patch-id="${patchId}"></diffs-container>
  </div>`;
}

export function renderComments(validFindings, ignoredFindings, options = {}) {
  const bubbles = [
    ...validFindings.map((finding) => renderFinding(finding, options)),
    ...ignoredFindings.map((finding) => renderFinding(finding, { ...options, dismissed: true })),
  ];

  return bubbles.length ? `<div class="comments">${bubbles.join("\n")}</div>` : "";
}

export function renderFindingList(validFindings, ignoredFindings, options = {}) {
  return [
    ...validFindings.map((finding) => renderFinding(finding, options)),
    ...ignoredFindings.map((finding) => renderFinding(finding, { ...options, dismissed: true })),
  ].join("\n");
}

export function renderFile(file, manifest) {
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

export function renderGeneralFindings(number, validFindings, ignoredFindings) {
  if (validFindings.length === 0 && ignoredFindings.length === 0) return "";

  return `<section>
  <div class="section-header"><span class="section-number">${number}</span><h2>General findings</h2></div>
  <div class="finding-list">
    ${renderFindingList(validFindings, ignoredFindings, { includeLocation: false })}
  </div>
</section>`;
}

export function renderFocusItems(number, items) {
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

export function renderTestPlan(number, items) {
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

export function renderArchitecture(number, architecture) {
  if (!architecture) return "";
  const diagram = architecture.diagramHtml
    ? `<div class="diagram-panel">${sanitizeDiagramHtml(architecture.diagramHtml)}</div>`
    : "";

  return `<section>
  <div class="section-header"><span class="section-number">${number}</span><h2>Where this sits today</h2></div>
  <div class="architecture-summary">${paragraphs(architecture.summary ?? "")}</div>
  ${diagram}
</section>`;
}

function fileTreeClass(badge) {
  if (badge === "NEW") return "file-new";
  if (badge === "DEL") return "file-del";
  return "file-mod";
}

export function renderFileTree(number, files, manifest) {
  if (files.length === 0) return "";

  return `<section>
  <div class="section-header"><span class="section-number">${number}</span><h2>File map</h2></div>
  <div class="legend"><span class="new">New</span><span class="mod">Modified</span><span class="del">Deleted</span></div>
  <div class="filetree">
    ${files
      .map((file) => {
        const note = manifest.fileNotes?.[file.path];
        return `<details class="filetree-row">
      <summary><span class="${fileTreeClass(file.badge)}">${html(file.path)}</span> <span class="file-badge ${file.badge.toLowerCase()}">${file.badge}</span></summary>
      <div class="details-body">
        <p><span class="risk-tag ${file.risk}">${file.risk}</span></p>
        ${note ? `<div class="note">${paragraphs(note)}</div>` : ""}
        <p><a href="#${file.id}">Jump to file tour</a></p>
      </div>
    </details>`;
      })
      .join("\n")}
  </div>
</section>`;
}

export function renderSummaryStrip({ files, totalAdditions, totalDeletions, validCount, ignoredCount }) {
  const highRiskFiles = files.filter((file) => file.risk === "attention").length;
  return `<div class="summary-strip">
    <div class="stat-card"><span class="stat-value">${files.length}</span><span class="stat-label">Files</span></div>
    <div class="stat-card"><span class="stat-value"><span class="additions">+${totalAdditions}</span> / <span class="deletions">-${totalDeletions}</span></span><span class="stat-label">Lines</span></div>
    <div class="stat-card"><span class="stat-value">${validCount}</span><span class="stat-label">Valid findings</span></div>
    <div class="stat-card"><span class="stat-value">${ignoredCount}</span><span class="stat-label">Ignored findings</span></div>
    <div class="stat-card"><span class="stat-value">${highRiskFiles}</span><span class="stat-label">High-risk files</span></div>
  </div>`;
}

function renderImplementorFinding(finding) {
  const snippet = finding.snippet ? renderSnippet(finding.snippet) : "";
  return `<div class="impl-finding">
    <h4>${html(finding.tag ?? finding.id ?? "finding")} · ${html(finding.filePath ?? finding.locationLabel ?? "general")} · ${html(finding.severity ?? "")}</h4>
    <p><strong>${html(finding.title ?? "Untitled finding")}</strong></p>
    ${snippet}
    <div class="impl-note">${paragraphs(finding.explanation ?? finding.body ?? "")}</div>
  </div>`;
}

export function renderImplementorDetail(validFindings) {
  const groups = groupFindingsByCategory(validFindings);
  const labels = {
    CORRECTNESS: "Correctness",
    CODESTYLE: "Codestyle",
    TESTING: "Testing",
    GENERAL: "General",
  };

  return `<hr class="divider">

<section>
  <div class="section-header"><span class="section-number">→</span><h2>Implementor detail</h2></div>
  <p class="section-sub">Confirmed multireview findings grouped for fixer handoff. Collapsed by default.</p>
  ${Object.entries(labels)
    .map(([category, label]) => {
      const findings = groups[category];
      return `<details>
    <summary>${label} (${findings.length})</summary>
    <div class="details-body">
      ${findings.length ? findings.map(renderImplementorFinding).join("\n") : `<p class="empty-state">No ${label.toLowerCase()} findings.</p>`}
    </div>
  </details>`;
    })
    .join("\n")}
</section>`;
}

export function renderTldr(tldr) {
  if (!tldr) return "";
  return `<div class="tldr"><h3>TL;DR</h3><p>${paragraphs(tldr)}</p></div>`;
}

export function renderWhy(number, why) {
  if (!why?.before && !why?.after) return "";
  return `<section>
      <div class="section-header"><span class="section-number">${number}</span><h2>Why</h2></div>
      <div class="before-after">
        <div class="ba-panel before"><h4>Before</h4><p>${paragraphs(why?.before || "")}</p></div>
        <div class="ba-panel after"><h4>After</h4><p>${paragraphs(why?.after || "")}</p></div>
      </div>
    </section>`;
}

export function renderHtml({ manifest, files, unmatchedValidFindings, unmatchedIgnoredFindings }) {
  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const validFindings = [...files.flatMap((file) => file.validFindings ?? []), ...unmatchedValidFindings];
  const ignoredFindings = [...files.flatMap((file) => file.ignoredFindings ?? []), ...unmatchedIgnoredFindings];
  const sections = {};
  let nextSection = 1;
  if (manifest.architecture) {
    sections.architecture = String(nextSection++).padStart(2, "0");
  }
  if (manifest.why?.before || manifest.why?.after) {
    sections.why = String(nextSection++).padStart(2, "0");
  }
  sections.fileTree = String(nextSection++).padStart(2, "0");
  sections.files = String(nextSection++).padStart(2, "0");
  if (unmatchedValidFindings.length || unmatchedIgnoredFindings.length) {
    sections.general = String(nextSection++).padStart(2, "0");
  }
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
  background: var(--card);
}

summary {
  font-family: var(--font-sans);
  font-weight: 600;
  padding: 14px 22px;
  cursor: pointer;
  list-style: none;
  font-size: 0.92rem;
}

summary::before {
  content: '▸';
  display: inline-block;
  margin-right: 10px;
  transition: transform 0.15s;
  color: var(--primary);
}

details[open] summary::before { transform: rotate(90deg); }

.details-body { padding: 0 22px 20px; }

.details-body h4 { font-family: var(--font-mono); font-size: 0.82rem; color: var(--primary); margin: 18px 0 6px; }
.details-body h4:first-child { margin-top: 4px; }
.details-body p { font-size: 0.87rem; color: var(--muted-foreground); margin-bottom: 8px; }

.summary-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin: 32px 0; }
.stat-card { border: 1.5px solid var(--border); border-radius: var(--radius); padding: 16px 20px; text-align: center; background: var(--card); }
.stat-value { font-family: var(--font-display); font-size: 1.7rem; font-weight: 500; display: block; }
.stat-label { font-family: var(--font-mono); font-size: 0.66rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted-foreground); margin-top: 4px; display: block; }

.summary-strip .additions { color: var(--success); }
.summary-strip .deletions { color: var(--destructive); }

.section-sub { font-size: 0.85rem; color: var(--muted-foreground); margin-top: -8px; margin-bottom: 20px; max-width: 68ch; }

.diagram-panel { border: 1.5px solid var(--border); border-radius: var(--radius); padding: 24px; margin: 20px 0; background: var(--card); overflow-x: auto; }

.architecture-summary { max-width: 760px; }

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

.bubble p,
.bubble .finding-explanation {
  margin-top: 6px;
  font-size: 0.88rem;
  line-height: 1.55;
  color: var(--foreground);
}

.code-panel { background: var(--code-bg); border-radius: var(--radius); padding: 18px; overflow-x: auto; margin: 14px 0; border: 1.5px solid var(--border); }
.code-label { font-family: var(--font-mono); font-size: 0.7rem; color: var(--muted-foreground); display: block; margin-bottom: 10px; }
.code-panel pre { margin: 0; font-family: var(--font-mono); font-size: 0.83rem; line-height: 1.6; color: var(--foreground); white-space: pre-wrap; }
.code-panel code { font-family: var(--font-mono); background: transparent; padding: 0; border-radius: 0; }
.code-panel .del { color: var(--destructive); text-decoration: line-through; opacity: 0.7; }
.code-panel .add { color: var(--success); font-weight: 600; }
.code-panel .line-context { color: var(--muted-foreground); }
.code-panel .line-matched { display: block; color: var(--foreground); background: color-mix(in oklab, var(--primary) 12%, transparent); font-weight: 700; }

.bubble .code-panel { margin: 10px 0; padding: 12px; }

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

.filetree { font-family: var(--font-mono); font-size: 0.85rem; line-height: 1.9; border: 1.5px solid var(--border); border-radius: var(--radius); background: var(--card); padding: 20px 24px; }
.filetree .file-mod { color: var(--warning); font-weight: 600; }
.filetree .file-new { color: var(--success); font-weight: 600; }
.filetree .file-del { color: var(--destructive); text-decoration: line-through; }
.filetree .note { color: var(--muted-foreground); font-style: italic; font-size: 0.78rem; }
.filetree-row { margin: 8px 0; }
.filetree-row summary { padding: 10px 14px; }
.legend { display: flex; gap: 20px; flex-wrap: wrap; margin: 14px 0 4px; font-family: var(--font-mono); font-size: 0.72rem; }
.legend span::before { content: '■ '; }
.legend .new { color: var(--success); }
.legend .mod { color: var(--warning); }
.legend .del { color: var(--destructive); }

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

hr.divider { border: none; border-top: 2px dashed var(--border); margin: 72px 0 48px; }
.impl-note { background: var(--muted); border-radius: var(--radius); padding: 10px 16px; font-size: 0.82rem; margin: 10px 0; }
.impl-note b { color: var(--destructive); }
.impl-finding { border-bottom: 1px solid var(--border); padding: 4px 0 14px; }
.impl-finding:last-child { border-bottom: none; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <span class="eyebrow">Pull request · ${html(manifest.repo || "repository")}</span>
      <h1>${html(manifest.prTitle || "PR explainer")}</h1>
    </header>

    ${renderSummaryStrip({ files, totalAdditions, totalDeletions, validCount: validFindings.length, ignoredCount: ignoredFindings.length })}

    ${renderArchitecture(sections.architecture, manifest.architecture)}

    ${renderTldr(manifest.tldr)}

    ${renderWhy(sections.why, manifest.why)}

    ${renderFileTree(sections.fileTree, files, manifest)}

    <section>
      <div class="section-header"><span class="section-number">${sections.files}</span><h2>File tour</h2></div>
      ${files.map((file) => renderFile(file, manifest)).join("\n")}
    </section>

    ${renderGeneralFindings(sections.general, unmatchedValidFindings, unmatchedIgnoredFindings)}

    ${renderFocusItems(sections.focus, manifest.focusItems)}
    ${renderTestPlan(sections.test, manifest.testPlan)}
    ${renderImplementorDetail(validFindings)}
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
    const { file, line, snippet } = matchFindingToFile(finding, files);
    const explanationText = explanation(finding.body);
    const locationLabel = file ? `${file.path}${line ? `:${line}` : ""}` : "general";
    const renderedFinding = {
      ...finding,
      tag: `[${finding.id}]`,
      explanation: explanationText,
      snippet,
      filePath: file?.path ?? null,
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
    const { file, line, snippet } = matchFindingToFile(finding, files);
    const locationLabel = file ? `${file.path}${line ? `:${line}` : ""}` : "general";
    const renderedFinding = {
      ...finding,
      tag: `[IGNORED-${index + 1}]`,
      explanation: explanation(finding.body),
      snippet,
      filePath: file?.path ?? null,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
