---
name: multireview-explainer
description: Runs the @multireview subagent and renders its findings as plain page content in a Plannotator-based PR explainer. Reviewers use Plannotator annotate mode's native select-text-to-comment feature to confirm findings, add context, or mark them wontfix. Use when the user asks to review a PR/changeset with multireview and wants a visual explainer, or asks to explain a diff with commentable findings.
---

# Multireview Explainer

Runs `@multireview`, turns `REVIEW_FINDINGS.md` into a Plannotator PR explainer, renders findings as plain page content, then triages the returned reviewer feedback back into the review loop.

The generated HTML intentionally reuses `plannotator-visual-explainer`'s design system and PR components instead of duplicating a separate visual language. If that skill's references change, revisit this skill's visual output too.

## Workflow

1. **Resolve scope** — Use the same target scope `@multireview` would use: uncommitted changes, branch diff, or PR reference. Ask the user if the intended scope is ambiguous.

2. **Get findings** — If `REVIEW_FINDINGS.md` does not exist yet, or is stale for the current scope, run `@multireview` fresh. Pass explicit plan content/reference and any phase/PR-slice identifier through the existing scope; never auto-discover a local plan. Surface the returned `complete`, `partial`, or `blocked` status and unresolved uncertainty IDs to the caller.

3. **Create a scratch directory** — Create a fresh scratch directory for this run and keep its path in `$SCRATCH` for the rest of the workflow. Do not write scratch files into the repository:
   ```bash
   SCRATCH="$(mktemp -d)"
   ```

4. **Parse findings** — Parse the findings into scratch JSON:
   ```bash
    opencode-multireview-parse-findings parse REVIEW_FINDINGS.md > "$SCRATCH"/findings.json
    ```
    Parse and render all valid findings and intent uncertainties. Blocked findings remain visible in the explainer; uncertainties are structured content only and never become line annotations.

5. **Get the diff** — Write the relevant unified diff to scratch, using `git diff` or the appropriate ref range for the resolved scope:
   ```bash
   git diff > "$SCRATCH"/diff.patch
   ```

6. **Author the narrative manifest** — This is the LLM-judgment step. Read the actual diff and findings, ground the reader in the current architecture before describing the diff/findings narrative, then write `manifest.json` to `$SCRATCH`:
   ```json
   {
     "repo": "string",
     "branch": "string",
     "prTitle": "string",
     "tldr": "2-3 sentences",
     "why": { "before": "string", "after": "string" },
      "architecture": { "summary": "string", "diagramHtml": "optional inline SVG, sanitized to an SVG-only element allowlist" },
     "fileNotes": { "path/to/file.ts": "why this file changed" },
     "focusItems": [{ "file": "path", "note": "what to check" }],
     "testPlan": [{ "text": "string", "done": false }]
   }
   ```
   `architecture.diagramHtml` may contain optional inline SVG only; the builder strips non-allowlisted SVG elements and unsafe event/protocol attributes before rendering it.

7. **Build the explainer** — Generate the static HTML:
   ```bash
   opencode-multireview-build-explainer \
     --findings "$SCRATCH"/findings.json \
     --diff "$SCRATCH"/diff.patch \
     --manifest "$SCRATCH"/manifest.json \
     --out "$SCRATCH"/explainer.html
   ```
   The generated page follows the parent PR explainer structure: a stat-card summary strip and expandable file tree orient the reviewer, each changed file renders its Pierre diff inline, and matched multireview findings attach as review bubbles with snippet-anchored code context under that diff. Ignored findings carried from a prior `REVIEW_FINDINGS.md` appear as dimmed, struck-through bubbles with their `wontfix` reason. Findings that cannot be matched to a changed file render in a conditional **General findings** section after the file tour, and a collapsed category-grouped **Implementor detail** section below the divider gives fixer-ready blocks.

8. **Launch Plannotator** — Start annotate mode, wait for it to be ready, then open the browser yourself. There is no draft payload to preload and no `/api/draft` POST; the reviewer can select text in the rendered finding bubbles or narrative and add native Plannotator comments directly:
   ```bash
   rm -f "$SCRATCH"/ready.json "$SCRATCH"/plannotator.log
   PLANNOTATOR_READY_FILE="$SCRATCH"/ready.json plannotator annotate "$SCRATCH"/explainer.html --json > "$SCRATCH"/plannotator.log 2>&1 &
   ```
   Poll until `ready.json` exists in `$SCRATCH`, parse its `url` or `port`, then run `open "http://localhost:<port>"`. Wait for the Plannotator process to exit, then read the last JSON line from the logfile. That line is `{"decision":"...","feedback":"...","annotations":[...]}` or an equivalent submitted result.

9. **Read returned feedback** — The returned `annotations` are the reviewer's own native Plannotator comments from selecting text in the rendered finding bubbles or narrative. They are not preloaded annotations. First check whether the session actually produced a submission at all: if the returned `feedback` is empty/missing, or `decision` is anything other than an explicit submission (e.g. the user closed the tab, the process was killed, or it timed out), **stop here and do not touch `REVIEW_FINDINGS.md`**. Report to the user that no review feedback was submitted and leave everything as-is.

10. **Triage returned feedback** — A finding is Valid by default unless a wontfix signal is received. There is no "absence = dismissed" behavior.

   For each returned `annotations[]` entry, attribute it to a finding by checking whether the annotation's `originalText` (the reviewer's exact text selection) is a substring of exactly one rendered finding bubble: visible `[MULTIREVIEW-<n>]` tag + title + explanation. The bubble may live inside a file card or in the **General findings** section. If the selection spans multiple findings or matches none uniquely, treat the annotation as general/ad-hoc feedback instead of attributing it to a specific finding.

   Then apply these rules:
   - Annotation attributed to a finding and the comment text contains `wontfix` case-insensitively → move that finding to Ignored Findings. If `wontfix:` has a colon, use the text after the colon as the reason; otherwise use the whole comment.
   - Annotation attributed to a finding with no `wontfix` mention → keep the finding in Valid Findings, but pass the reviewer's comment through as extra context for `@fixer`.
   - Scan the free-text `feedback` field as a fallback for direct `MULTIREVIEW-<n>` tag mentions. Tag mentioned with surrounding `wontfix` text → move that finding to Ignored Findings using the same reason extraction. Tag mentioned without `wontfix` → keep it Valid and pass the feedback through as extra fixer context.
   - Feedback or annotations with no attributable `MULTIREVIEW-<n>` finding → treat as fresh ad-hoc reviewer feedback. Hand it to `@fixer` alongside confirmed findings; do not file it into `REVIEW_FINDINGS.md`.

11. **Rewrite `REVIEW_FINDINGS.md`** — Serialize the updated valid, uncertainty, and ignored arrays:
    ```bash
    opencode-multireview-parse-findings serialize "$SCRATCH"/updated-findings.json > REVIEW_FINDINGS.md
    ```

12. **Hand off** — Before handing off, partition the parsed report and pass only actionable valid findings to `@fixer`:
    ```bash
    opencode-multireview-parse-findings partition-actionable "$SCRATCH"/findings.json > "$SCRATCH"/actionable.json
    ```
    Pass only `.actionable` plus attributed reviewer comments and ad-hoc feedback. Never pass `.blocked`, ignored findings, or uncertainties. Independent findings may complete triage while blocked findings wait.

13. **Clarification and report** — Surface each uncertainty question and ID when the invoking agent can interact. Do not rerun until the caller supplies answers/evidence; then invoke an intent-only clarification rerun with the mapping in the existing scope and regenerate the report/explainer. If invoked by another agent without that capability, return the partial/blocked status and IDs. Never use annotation deletion or `Wontfix` to resolve uncertainty. Summarize what was dismissed and why, what actionable work is being fixed, and where the static HTML explainer was saved.
