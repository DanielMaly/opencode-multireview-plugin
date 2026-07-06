---
name: multireview-diff
description: Runs @multireview and loads findings as preloaded comments into Plannotator's native diff-review UI with file tree and real diff viewer, not the HTML explainer. Use when the user asks to "review this PR with the native diff view", "multireview diff mode", "preload comments into plannotator review", or wants findings triaged back into REVIEW_FINDINGS.md after reviewing/editing/dismissing comments in the native UI.
---

# Multireview Diff

Runs `@multireview`, converts valid findings into native Plannotator `review --git` line comments, lets the user review/edit/delete them in the native diff UI, then triages the submitted result back into `REVIEW_FINDINGS.md` and the fixer handoff.

This skill uses Plannotator's native diff-review mode: file tree, navigable files, and real diff line comments. It does not generate a static HTML explainer.

## Workflow

1. **Resolve scope** — Use the same target scope `@multireview` would use: uncommitted changes, branch diff, or PR reference. Ask the user if the intended scope is ambiguous.

2. **Get findings** — If `REVIEW_FINDINGS.md` does not exist yet, or is stale for the current scope, run `@multireview` fresh. Follow the plan-executor convention: provide no additional context beyond the changeset, and do not reuse previous multireview sessions.

3. **Create a scratch directory** — Create a fresh scratch directory for this run and keep its path in `$SCRATCH` for the rest of the workflow. Do not write scratch files into the repository:
   ```bash
   SCRATCH="$(mktemp -d)"
   ```

4. **Parse findings** — Reuse the explainer skill's markdown parser directly; it is pure `REVIEW_FINDINGS.md` parsing and has no HTML/diff coupling:
   ```bash
   opencode-multireview-parse-findings parse REVIEW_FINDINGS.md > "$SCRATCH"/findings.json
   ```

5. **Get the diff** — Write the relevant unified diff to scratch, using `git diff` or the appropriate ref range for the resolved scope:
   ```bash
   git diff > "$SCRATCH"/diff.patch
   ```

6. **Build code annotations** — Convert matched valid findings into Plannotator review-mode code annotations:
   ```bash
   opencode-multireview-build-code-annotations \
     --findings "$SCRATCH"/findings.json \
     --diff "$SCRATCH"/diff.patch \
     --out "$SCRATCH"/code-annotations.json \
     > "$SCRATCH"/unmatched-findings.json
   ```
   Surface any unmatched findings from `unmatched-findings.json` to the user and later to `@fixer` as general feedback, because they cannot be attached to a specific diff line.

7. **Launch native review mode and wait for readiness** — Use `PLANNOTATOR_READY_FILE`; poll for the ready file instead of sleep-guessing:
   ```bash
   rm -f "$SCRATCH"/ready.json "$SCRATCH"/review.log
   PLANNOTATOR_READY_FILE="$SCRATCH"/ready.json plannotator review --git --json > "$SCRATCH"/review.log 2>&1 &
   ```
   Poll until `ready.json` exists in `$SCRATCH`, then parse it for `port`.

8. **Preload draft comments, then open** — Build a review-mode draft payload, POST it, then explicitly open the URL.

9. **Read the submitted review result** — Wait for the backgrounded `plannotator review` process to exit, then read the last non-empty line of `review.log` and attempt `JSON.parse`. Defensively look for `feedback` as a string and `annotations` as an array. If parsing fails or those fields are absent, treat it like an abandoned session: do not touch `REVIEW_FINDINGS.md`, and report the raw log tail to the user for debugging rather than guessing.

10. **Triage returned feedback** — First check whether the session actually produced a submission at all: if the returned `feedback` is empty/missing, or the expected result fields are missing, **stop here and do not touch `REVIEW_FINDINGS.md`**. Treat "tag absent = dismissed" as valid only when the user genuinely submitted feedback — an abandoned session must never be read as "the user wants every finding dismissed."

   Otherwise, cross-reference the returned `annotations` and `feedback` against the known preloaded `MULTIREVIEW-<n>` tags from steps 4 and 6:
   - Tag mentioned and the surrounding text contains `wontfix` case-insensitively → move that finding to Ignored Findings.
   - Tag mentioned with no `wontfix` → keep the finding in Valid Findings as confirmed.
   - Tag not mentioned anywhere in feedback or returned annotations (and feedback was genuinely submitted, per the guard above) → treat it as dismissed because the reviewer removed the annotation. Move it to Ignored Findings with `**Wontfix: Dismissed via Plannotator (annotation removed by reviewer)**`.
   - Feedback text with no `MULTIREVIEW-<n>` tag at all → treat it as fresh ad-hoc reviewer feedback.

11. **Rewrite `REVIEW_FINDINGS.md`** — Serialize the updated valid/ignored arrays:
    ```bash
    opencode-multireview-parse-findings serialize "$SCRATCH"/updated-findings.json > REVIEW_FINDINGS.md
    ```

12. **Hand off** — Pass the confirmed Valid Findings, any ad-hoc feedback, and any unmatched findings from step 6 to `@fixer` to implement.

13. **Report to the user** — Summarize what was dismissed and why, what is being fixed, and that the review happened in native Plannotator diff mode with a navigable file tree rather than a generated static HTML file.
