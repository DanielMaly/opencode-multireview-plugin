---
name: mmar
description: Use MMAR for durable, scope-isolated multi-model code reviews when the caller requests an MMAR review.
---

# MMAR caller workflow

Use this skill when the caller asks for an MMAR review. MMAR is a durable, scope-isolated review process; it is not a request to create or update a repository Markdown findings file.

## Establish the scope

1. Normalize the requested changeset as one supported target: pull request, branch, commit, uncommitted worktree, or an explicit custom changeset.
2. Require a base ref. Resolve it before delegation and stop with an actionable error if it cannot be resolved. Do not begin a review with an unresolved base.
3. Keep the target, resolved base, project, worktree, and request scope compact. Pass that scope to `mmar_orchestrator`; do not relay the full diff as caller metadata.

## Resolve optional intent

An intent source is optional. A Jira key or URL must be retrieved through the caller's authenticated Jira integration. A local source must be read from the exact caller-supplied path.

- On success, pass the resolved source content to `mmar_orchestrator`, while the typed normalized reference is the only source value persisted.
- On failure, pass the reference and a concise resolution error. Still launch `mmar_intent`; never invent content and never silently downgrade to a no-intent review.
- With no source, omit intent. The independent correctness, codestyle, and testing specialists still run, and the current review-level intent reference is cleared.

## Reuse sessions safely

Call and retain the same `mmar_orchestrator` session for repeated work with the same project, target, and resolved base whenever the caller still has that session context. A different target or base is a different scope: start a new orchestrator session and do not carry findings between scopes.

The orchestrator must call `mmar_begin` before inspecting the changeset or spawning specialists. It must pass the required base ref, target, request scope, and typed intent reference. A successful begin returns a review ID, round ID, fencing token, and any prior ignored entries for revalidation. Prior ignored entries are candidates only; verify them against the current changeset and omit stale entries.

## Lock and failure behavior

If `mmar_begin` reports an active lock, show its review ID and acquisition timestamp, spawn no specialists, and exit cleanly. Treat this as another active invocation, not as a reason to bypass the lock.

After a successful begin, always complete exactly once, including partial and blocked runtime results. If orchestration fails after begin, report the review and round IDs, inspect the lock, and ask the user before running:

```bash
opencode-multireview unlock <review-id>
```

Use `--force` only when the user explicitly confirms in a non-interactive environment. Never unlock speculatively. A stale orchestrator must not complete after its fencing token has been replaced.

Source-resolution failure produces intent uncertainty. Independent specialists still run; report `partial` when at least one independent valid finding remains actionable and `blocked` when none does. Route uncertainty questions back to the caller and reuse the same scope/session for clarification rounds.

## Output boundary

Agents must not create, read, modify, or use `REVIEW_FINDINGS.md`, other agent Markdown files, or git excludes. Only explicit CLI output may create a Markdown projection:

```bash
opencode-multireview export <review-id> [--round <round-id>] [--output <path>]
```

The SQLite history and plugin tools are the canonical persistence layer. The skill provides caller guidance only; it does not implement persistence.
