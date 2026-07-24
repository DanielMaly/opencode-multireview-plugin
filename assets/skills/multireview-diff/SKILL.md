---
name: multireview-diff
description: Runs @multireview and loads findings as preloaded comments into Plannotator's native diff-review UI with file tree and real diff viewer, not the HTML explainer. Use when the user asks to "review this PR with the native diff view", "multireview diff mode", "preload comments into plannotator review", or wants findings triaged back into REVIEW_FINDINGS.md after reviewing/editing/dismissing comments in the native UI.
---

# Multireview Diff

Runs `@multireview`, converts valid findings into native Plannotator `review --git` line comments, lets the user review/edit/delete them in the native diff UI, then triages the submitted result back into `REVIEW_FINDINGS.md` and the fixer handoff.

This skill uses Plannotator's native diff-review mode: file tree, navigable files, and real diff line comments. It does not generate a static HTML explainer.

## Workflow

1. **Resolve scope** — Use the same target scope `@multireview` would use: uncommitted changes, branch diff, or PR reference. Ask the user if the intended scope is ambiguous.

2. **Get findings** — If `REVIEW_FINDINGS.md` does not exist yet, or is stale for the current scope, run `@multireview` fresh. Pass explicit plan content/reference and any phase/PR-slice identifier through the existing scope; never auto-discover a local plan. Surface the returned `complete`, `partial`, or `blocked` status and unresolved uncertainty IDs to the caller.

3. **Create a scratch directory** — Create a fresh scratch directory for this run and keep its path in `$SCRATCH` for the rest of the workflow. Do not write scratch files into the repository:
   ```bash
   SCRATCH="$(mktemp -d)"
   ```

4. **Parse findings** — Reuse the explainer skill's markdown parser directly; it is pure `REVIEW_FINDINGS.md` parsing and has no HTML/diff coupling:
   ```bash
    opencode-multireview-parse-findings parse REVIEW_FINDINGS.md > "$SCRATCH"/findings.json
    ```
    Parse and render all valid findings and intent uncertainties. Keep blocked findings visible in Plannotator; uncertainties never become line annotations.

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

8. **Post external annotations, verify, then open** — POST the code annotations as JSON to `POST /api/external-annotations` on the running Plannotator review server, for example `http://localhost:<port>/api/external-annotations`. The request body must be `{"annotations": [...]}`, where each annotation object is one of the entries emitted by `opencode-multireview-build-code-annotations` in step 6, including its required `source` field. Do not manually patch the generated annotation objects.

   Do **not** use `/api/draft`. That endpoint is for the reviewer's own persisted draft state across reloads and is not consumed by the diff-review UI's comment feed.

   The diff-review UI subscribes to `/api/external-annotations` via SSE at `/api/external-annotations/stream`, plus a polling fallback with a `since=<version>` cursor. A successful POST returns `201 Created` with a list of assigned annotation `ids`. Before opening the browser, verify with `GET /api/external-annotations` that `version` incremented and the annotations are present.

   Only open the review URL after the POST succeeds and the verification GET reflects the annotations.

9. **Read the submitted review result** — Wait for the backgrounded `plannotator review` process to exit, then read the last non-empty line of `review.log` and attempt `JSON.parse`. Defensively look for `feedback` as a string and `annotations` as an array. If parsing fails or those fields are absent, treat it like an abandoned session: do not touch `REVIEW_FINDINGS.md`, and report the raw log tail to the user for debugging rather than guessing.

10. **Triage returned feedback** — First check whether the session actually produced a submission at all: if the returned `feedback` is empty/missing, or the expected result fields are missing, **stop here and do not touch `REVIEW_FINDINGS.md`**. Treat "tag absent = dismissed" as valid only when the user genuinely submitted feedback — an abandoned session must never be read as "the user wants every finding dismissed."

   Otherwise, cross-reference the returned `annotations` and `feedback` against the known preloaded `MULTIREVIEW-<n>` tags from steps 4 and 6:
   - Tag mentioned and the surrounding text contains `wontfix` case-insensitively → move that finding to Ignored Findings.
   - Tag mentioned with no `wontfix` → keep the finding in Valid Findings as confirmed.
   - Tag not mentioned anywhere in feedback or returned annotations (and feedback was genuinely submitted, per the guard above) → treat it as dismissed because the reviewer removed the annotation. Move it to Ignored Findings with `**Wontfix: Dismissed via Plannotator (annotation removed by reviewer)**`.
   - Feedback text with no `MULTIREVIEW-<n>` tag at all → treat it as fresh ad-hoc reviewer feedback.

11. **Rewrite `REVIEW_FINDINGS.md`** — Serialize the updated valid, uncertainty, and ignored arrays:
    ```bash
    opencode-multireview-parse-findings serialize "$SCRATCH"/updated-findings.json > REVIEW_FINDINGS.md
    ```

12. **Hand off** — Before handing off, partition the parsed report and pass only actionable valid findings to `@fixer`:
    ```bash
    opencode-multireview-parse-findings partition-actionable "$SCRATCH"/findings.json > "$SCRATCH"/actionable.json
    ```
    Pass only `.actionable` plus any ad-hoc feedback and unmatched findings. Never pass `.blocked`, ignored findings, or uncertainties. Independent findings may complete triage while blocked findings wait.

13. **Clarification and report** — If the invoking agent can interact, surface each uncertainty question and ID. Do not rerun until the caller supplies answers/evidence; then invoke an intent-only clarification rerun with the mapping in the existing scope and regenerate the report/review. If invoked by another agent without that capability, return the partial/blocked status and IDs. Never use annotation deletion or `Wontfix` to resolve uncertainty. Summarize what was dismissed and why, what actionable work is being fixed, and that the review happened in native Plannotator diff mode.
