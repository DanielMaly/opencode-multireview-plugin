# opencode-multireview-plugin

Local-first MMAR (multi-model adversarial review) tooling for OpenCode. The plugin provides five renamed agents, durable SQLite review history, fenced locks, deterministic export, and the caller-facing `mmar` skill.

## Install

```bash
npm install opencode-multireview-plugin
opencode-multireview skill install --global
```

The manual installer is recommended for project-local installs:

```bash
opencode-multireview skill install --project
```

The global skill is installed at `${XDG_CONFIG_HOME}/opencode/skills/mmar/SKILL.md` when `XDG_CONFIG_HOME` is set, otherwise at `~/.config/opencode/skills/mmar/SKILL.md`. Project installs go to `<project>/.opencode/skills/mmar/SKILL.md`. These are OpenCode-native paths; no `.claude` or `.agents` compatibility path is used.

`npm install` asks `Install skill (recommended)? [Y/n]` only when both standard streams are TTYs. `n` skips. A non-interactive install succeeds without changing user configuration and prints the manual global install command. Use the manual command for repair or explicit project installation.

Each installed skill has a `.provenance.json` sidecar containing the package name, version, and content checksum. A missing copy is created; an unchanged plugin-owned older copy is updated; an unchanged current copy is left alone. A modified or unowned copy is preserved and never silently overwritten. `npm uninstall` therefore cannot silently remove user-owned or modified skill files.

Add the plugin to OpenCode configuration if it is not already loaded:

```json
{
  "plugin": ["opencode-multireview-plugin"]
}
```

Restart OpenCode after changing plugin configuration.

## MMAR operations

The `mmar` skill is the review entrypoint. It normalizes a target (pull request, branch, commit, uncommitted worktree, or custom changeset), requires and resolves a base ref, and then delegates compact scope metadata to `mmar_orchestrator`.

An optional Jira key/URL is resolved through the caller's authenticated Jira integration. An explicit local intent path is read exactly as supplied. Successful content is passed to the intent agent, but only the normalized reference is persisted. Failed resolution passes the reference and concise error, still launches `mmar_intent`, and produces intent uncertainty; it never invents content or silently becomes a no-intent review.

The same project/target/resolved-base scope can reuse the orchestrator session across caller sessions. A different target or base starts a new scope and cannot inherit unrelated findings. `mmar_begin` runs before diff inspection or specialist spawning. Lock contention reports the active review and exits without spawning specialists. If orchestration fails after acquisition, inspect the lock and ask before recovery:

```bash
opencode-multireview unlock <review-id>
```

Use `--force` only after explicit confirmation in a non-interactive environment. Locks do not expire automatically, and fencing prevents a stale invocation from completing after recovery.

Agents never read or write `REVIEW_FINDINGS.md`, other agent Markdown, or git excludes. SQLite is canonical. Markdown is an explicit CLI projection only:

```bash
opencode-multireview list [--all-projects] [--json]
opencode-multireview export <review-id> [--round <round-id>] [--output <path>]
opencode-multireview unlock <review-id> [--force]
```

Exports are deterministic and can select the latest or any immutable historical round. `--output` writes atomically.

## Storage and configuration

The database is created on first use and migrated with packaged, checksummed forward-only SQL migrations. Its default location is:

- macOS: `~/Library/Application Support/opencode-multireview/reviews.sqlite`
- Windows: `%LOCALAPPDATA%/opencode-multireview/reviews.sqlite`
- Linux/other: `$XDG_DATA_HOME/opencode-multireview/reviews.sqlite`, or `~/.local/share/opencode-multireview/reviews.sqlite`

The database stores review identity, immutable structured rounds, findings, uncertainties, and lock metadata. It does not store fetched Jira/local source content, full diffs, transcripts, or Markdown files.

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

## Publishing

Publishing and tagging remain the final release action after all v1 gates pass. Do not use `npm run release` until the real installed-skill OpenCode smoke gate has passed.
