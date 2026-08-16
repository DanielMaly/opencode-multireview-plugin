---
name: mmar
description: Run MMAR (multi-model adversarial review) as a durable, scope-isolated code review. Use when the user requests MMAR, multireview, or a multi-model adversarial review of a pull request, branch, commit, worktree, or custom changeset.
---

# MMAR caller workflow

Use this skill to call the MMAR plugin. Prepare one review request, delegate it to `mmar_orchestrator`, and present the result to the user. The orchestrator owns review lifecycle, specialist dispatch, adjudication, and persistence.

Do not dispatch hidden lane specialists directly. Do not create or update a repository Markdown findings file.

## Prepare the request

1. Normalize the requested changeset as one supported target: pull request, branch, commit, uncommitted worktree, or explicit custom changeset.
2. Require a Git-resolvable base ref. Stop with an actionable error if it cannot be resolved.
3. Summarize the requested review as a compact `requestScope`. Do not embed the full diff as metadata.
4. Choose lanes only when the user requests a narrower review, or when the scope of the change is small enough that a swarm of reviewer agents does not make sense.
5. Resolve optional intent before delegation.

Supported lanes are:

- `correctness`
- `codestyle`
- `testing`
- `intent`

Omit `lanes` for the default review: correctness, codestyle, and testing, plus intent when an intent reference is supplied. Explicit lane lists are exact; empty, duplicate, and unknown lists are invalid. Selecting `intent` requires an intent reference. Optional `instructions` may focus the review but cannot override lane boundaries or MMAR lifecycle rules.

## Resolve optional intent

Intent may come from a ticket tracking system or an exact user-supplied local file path.

- If the user supplies intent via a ticket / issue reference, resolve it before delegation using the integration available in your environment.
- If the user supplies a local source, read it from the exact supplied path.
- On success, pass the source content to the orchestrator and include its typed reference in the request.
- On failure, pass the typed reference and a concise resolution error. Do not invent source content or silently remove a selected intent lane.
- With no intent source, omit intent entirely.

## Delegate once

Construct one versioned request envelope and send it to `mmar_orchestrator` in a single delegation.

```text
<mmar_request>
{
  "version": 1,
  "target": { ... },
  "baseRef": "main",
  "requestScope": "Review lock expiry handling",
  "lanes": ["correctness"],
  "instructions": "Pay particular attention to stale-lock recovery."
}
</mmar_request>
```

When intent is present, include its typed reference and either resolved content or a resolution error in the envelope expected by the orchestrator.

Reuse the same `mmar_orchestrator` session for follow-up rounds with the same project, target, and resolved base. Start a new session for a different target or base. Do not carry findings between scopes.

## Handle the result

Present the orchestrator's review ID, round ID, runtime status, findings, ignored findings, and unresolved uncertainty questions.

- `complete`: the round has no unresolved intent uncertainty.
- `partial`: uncertainty remains, but at least one finding is independently actionable.
- `blocked`: uncertainty remains and no finding is independently actionable.

Ask the user any returned clarification questions. For a clarification round, reuse the same scope and orchestrator session.

If the orchestrator reports an active lock, show the review ID and acquisition time. Do not start another review or bypass the lock.

If orchestration fails after a review begins, report the review and round IDs. Inspect the lock and ask the user before running:

```bash
opencode-multireview unlock <review-id>
```

Use `--force` only with explicit user confirmation in a non-interactive environment. Never unlock speculatively.

## Retrieve prior reviews

Historical retrieval does not require a new MMAR round or delegation to `mmar_orchestrator`.

- Use `mmar_list_reviews` to discover prior reviews.
- Use `mmar_get_findings` to retrieve a completed round.
- Omit `worktreePath` for the current session worktree.
- For another local worktree, pass its exact absolute Git worktree root.

Explicit non-Git paths are unsupported. Uncommitted reviews remain isolated to the exact selected worktree. Historical tools are read-only and expose no database path, SQL, lock ownership, or fencing credentials.

For a human-facing Markdown projection, use:

```bash
opencode-multireview export <review-id> [--round <round-id>] [--output <path>]
```

SQLite history and plugin tools are the canonical persistence layer. 

