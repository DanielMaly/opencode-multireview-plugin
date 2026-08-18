# opencode-multireview-plugin

Local-first MMAR (multi-model adversarial review) tooling for OpenCode. The plugin provides five renamed agents, durable SQLite review history, fenced locks, deterministic export, effective finding dispositions, and the caller-facing `mmar` skill.

## Install

```bash
npm install opencode-multireview-plugin
```

When the plugin is loaded by OpenCode, its bundled `assets/skills` directory is added to OpenCode's skill discovery automatically. No global or project skill copy is required.

The installer is an optional standalone/fallback path. For a global copy:

```bash
opencode-multireview skill install --global
```

For a project-local standalone copy:

```bash
opencode-multireview skill install --project
```

The global skill is installed at `${XDG_CONFIG_HOME}/opencode/skills/mmar/SKILL.md` when `XDG_CONFIG_HOME` is set, otherwise at `~/.config/opencode/skills/mmar/SKILL.md`. Project installs go to `<project>/.opencode/skills/mmar/SKILL.md`. These are OpenCode-native paths; no `.claude` or `.agents` compatibility path is used.

`npm install` offers `Install standalone skill copy (optional)? [y/N]` only when both standard streams are TTYs. A non-interactive install succeeds without changing user configuration and prints the optional fallback command. Use the manual command only for standalone operation, repair, or explicit project installation.

Each installed skill has a `.provenance.json` sidecar containing the package name, version, and content checksum. A missing copy is created; an unchanged plugin-owned older copy is updated; an unchanged current copy is left alone. A modified or unowned copy is preserved and never silently overwritten. `npm uninstall` therefore cannot silently remove user-owned or modified skill files.

Add the plugin to OpenCode configuration if it is not already loaded:

```json
{
  "plugin": ["opencode-multireview-plugin"]
}
```

Restart OpenCode after changing plugin configuration.

References to third-party `@multireview` packages or integrations remain outside this plugin and are not resolved or imported. The removed legacy `multireview*` agent and CLI aliases do not exist.

## MMAR operations

The `mmar` skill is the review entrypoint. It normalizes a target (pull request, branch, commit, uncommitted worktree, or custom changeset), requires and resolves a base ref, and then delegates compact scope metadata to `mmar_orchestrator`.

For historical discovery or findings retrieval, any agent with a valid context and session may call the read-only `mmar_list_reviews` and `mmar_get_findings` tools directly; delegation to `mmar_orchestrator` is unnecessary. Omit `worktreePath` to preserve the current session-worktree behavior. When the requested worktree differs from the OpenCode session root, pass its exact absolute Git worktree root to either read tool. This intentionally widens model-facing read access to persisted findings for known local Git worktrees, including siblings and paths outside the session root; explicit non-Git paths are unsupported. Uncommitted reviews remain limited to the exact selected worktree. Listing includes lock acquisition metadata but never fencing tokens, and these read tools do not grant database-path selection, SQL, writes, lock ownership, or fencing credentials. `mmar_begin` and `mmar_complete` remain runtime-exclusive to `mmar_orchestrator` and are explicitly denied in bundled specialist configuration; they do not accept `worktreePath`. `mmar_set_finding_disposition` uses the trusted current worktree, accepts only finding ID, disposition, and optional reason, and is denied to canonical specialists by configuration and runtime. The CLI remains the human-facing Markdown/history interface.

An optional Jira key/URL is resolved through the caller's authenticated Jira integration. An explicit local intent path is read exactly as supplied. Successful content is passed to the intent agent, but only the normalized reference is persisted. Failed resolution passes the reference and concise error, still launches `mmar_intent`, and produces intent uncertainty; it never invents content or silently becomes a no-intent review.

The same project/target/resolved-base scope can reuse the orchestrator session across caller sessions. A different target or base starts a new scope and cannot inherit unrelated findings. `mmar_begin` runs before diff inspection or specialist spawning. Lock contention reports the active review and exits without spawning specialists. If orchestration fails after acquisition, inspect the lock and ask before recovery:

```bash
opencode-multireview unlock <review-id>
```

Use `--force` only after explicit confirmation in a non-interactive environment. Locks do not expire automatically, and fencing prevents a stale invocation from completing after recovery.

Normal `session.idle` events are intentionally ignored: OpenCode emits them for ordinary per-turn idle, including while background child sessions remain active, so idle alone is not evidence that a review was abandoned. Runtime incomplete-review diagnostics use `session.error` only. Explicit lock recovery remains available through the command above.

Agents never read or write `REVIEW_FINDINGS.md`, other agent Markdown, or git excludes. SQLite is canonical. Markdown is an explicit CLI projection only:

```bash
opencode-multireview list [--all-projects] [--json]
opencode-multireview export <review-id> [--round <round-id>] [--output <path>]
opencode-multireview unlock <review-id> [--force]
opencode-multireview dismiss <finding-id> [reason]
opencode-multireview restore <finding-id>
```

`dismiss` stores a non-empty reason; supplied reasons are normalized by storage. If the reason is omitted, the CLI prompts only when both stdin and stdout are TTYs. Otherwise, provide the positional reason. For a reason beginning with `-`, separate positional arguments with `--`, for example `opencode-multireview dismiss 42 -- -duplicate`. `restore` removes an effective dismissal. Both commands address a finding globally by ID, and storage permits changes only for the latest completed round when no active review lock exists; lock and stale-round errors are preserved.

Exports are deterministic and can select the latest effective round or any immutable historical round. `--output` writes atomically. Finding IDs are exposed by structured retrieval. Disposition changes affect effective exports without changing the original finding content hashes or round payload hashes, so exact historical exports retain their original snapshots and metadata.

## Storage and configuration

The database is created on first use and migrated with packaged, checksummed forward-only SQL migrations. Its default location is:

- macOS: `~/Library/Application Support/opencode-multireview/reviews.sqlite`
- Windows: `%LOCALAPPDATA%/opencode-multireview/reviews.sqlite`
- Linux/other: `$XDG_DATA_HOME/opencode-multireview/reviews.sqlite`, or `~/.local/share/opencode-multireview/reviews.sqlite`

The database stores review identity, immutable structured rounds, findings, current disposition overrides, uncertainties, and lock metadata. Finding rows, their `contentHash`, and round `payloadHash` remain hashes of the original completion snapshot. Effective reads group findings by the current disposition and expose original disposition metadata when an override exists; prior ignored candidates use that effective state. It does not store fetched Jira/local source content, full diffs, transcripts, or Markdown files.

Model defaults and profiles remain configurable in `~/.config/opencode/multireview-plugin.json`; plugin tuple options can override `configPath` and model selections. The reviewer keys are `coordinator`, `correctness`, `codestyle`, `testing`, and `intent`.

## v1 breaking changes

- The old `multireview*` agent names and old parser CLI are removed; there are no compatibility aliases.
- `opencode-multireview-parse-findings` and `assets/scripts/parse-review-findings.mjs` are removed. Use `opencode-multireview export` for explicit Markdown projection.
- `REVIEW_FINDINGS.md` is neither imported nor read, written, or deleted by v1 agents. Existing files remain untouched.
- Existing per-repository legacy agents, skills, and tools are neither imported nor removed. The `mmar_*` names avoid those collisions.
- Review identity now includes project, normalized target, and resolved base commit. A required or unresolvable base prevents a review from starting.
- Review history is SQLite-backed and locks are fenced; there is no Markdown fallback or automatic lock expiry.

## Development

Requires Node `>=24.15.0`.

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```

The deterministic suite does not invoke a paid/live model. Live-model routing remains a manual verification limitation.

## Publishing

Releases are published to npm via a GitHub Actions workflow using npm trusted publishing (OIDC), triggered when a `vX.Y.Z` tag is pushed. The same workflow creates the GitHub Release automatically.

Cut releases with `release-it`:

```bash
npm run release
```

To preview a release without changing anything:

```bash
npm run release:dry-run
```
