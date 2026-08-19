# opencode-multireview-plugin

Multi-model adversarial code review (MMAR) for OpenCode. One review sends your changeset to several specialist agents at once, each running on a different model, then has a coordinator verify and adjudicate what they found. Every review is stored in a local SQLite database, so findings survive the session that produced them.

## Why this exists

**One reviewer misses things.** A single model asked to "review this PR" spreads its attention thin and tends to report whatever it noticed first. MMAR gives each specialist one job — correctness, code style, testing, or intent — and tells it to ignore everything else. Narrow scope produces sharper findings.

**Different models fail differently.** Each lane runs on its own configurable model. Where they disagree is usually where the interesting problems are.

**Findings need to be verified, not just collected.** The coordinator does not simply concatenate specialist output. It independently checks each claim against the code and drops the ones that do not hold up. You get an adjudicated list, not four opinions stapled together.

**Reviews should outlive the chat.** Results go into SQLite, keyed by project, target, and base commit. You can come back a week later, list past reviews, and pull up exactly what was found. Follow-up rounds on the same changeset revalidate earlier findings instead of starting from nothing, and dismissed findings stay dismissed with the reason you gave.

## Install

```bash
npm install opencode-multireview-plugin
```

This is a local install, so run maintenance commands with `npx opencode-multireview`. Registering the plugin with OpenCode does not add the command to your shell's `PATH`. If you prefer to run `opencode-multireview` directly, install the package globally with `npm install --global opencode-multireview-plugin`.

Then register the plugin in your OpenCode configuration if it is not already loaded, and restart OpenCode:

```json
{
  "plugin": ["opencode-multireview-plugin"]
}
```

Plugin registration is required for reviews: it supplies the orchestrator agents and MMAR tools, and registers the `mmar` skill directly with OpenCode. No manual skill copying is needed when the plugin is loaded.

### Standalone skill install (optional)

These commands copy the standalone workflow instructions for discovery outside plugin-loaded skills. A copied `SKILL.md` cannot execute MMAR by itself, but an agent with shell permission can use it to run CLI maintenance commands such as export and unlock. The plugin must still be registered to perform reviews:

```bash
npx opencode-multireview skill install --global   # ~/.config/opencode/skills/mmar/SKILL.md
npx opencode-multireview skill install --project  # <project>/.opencode/skills/mmar/SKILL.md
```

`XDG_CONFIG_HOME` is respected for global installs.

Each installed copy gets a `.provenance.json` sidecar recording package name, version, and checksum. Missing copies are created and outdated plugin-owned copies are updated. If you have edited the file, or it was not installed by this plugin, it is left alone — uninstalling never deletes your own work.

## Running a review

Ask for a review in OpenCode ("run MMAR on this branch", "multireview this PR") and the `mmar` skill takes over. It works out what you want reviewed, resolves the base ref, and hands a single request to the `mmar_orchestrator` agent.

OpenCode's default [`subagent_depth`](https://opencode.ai/docs/config/#subagent-depth) is `1`. To let another agent invoke `mmar_orchestrator`, which then launches the specialist agents, set the depth to `2` in your OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "subagent_depth": 2
}
```

Alternatively, use `mmar_orchestrator` directly as the primary agent. It can launch the specialists with the default depth of `1`.

You can review a **pull request, branch, commit, uncommitted worktree, or custom changeset**. A resolvable base ref is required; without one the review stops with an error rather than guessing.

By default three lanes run: correctness, code style, and testing. Add an intent reference — a Jira key, a ticket URL, or a local file path — and a fourth lane checks the change against what was actually asked for. You can also pick lanes explicitly for a narrower review.

Each round comes back with a status:

- **complete** — nothing unresolved.
- **partial** — some questions remain, but there are findings you can act on now.
- **blocked** — questions remain and nothing is actionable until you answer them.

Answer any clarification questions and run another round on the same scope to refine the result.

### Scope isolation and locking

A review is identified by project, normalized target, and resolved base commit. Change the target or the base and you get a fresh review; findings never leak between unrelated scopes.

`mmar_begin`, `mmar_complete`, and `mmar_set_finding_disposition` accept an optional absolute `worktreePath`. When supplied, the path is canonicalized and must name a Git worktree root, so a session in any directory can operate on that worktree. Omitting it preserves the current-worktree behavior. Reuse the canonical `repository.worktreePath` returned by `mmar_begin` for completion and subsequent tool calls.

For example, include the path alongside the normal tool payload:

```json
{
  "worktreePath": "/absolute/path/to/worktree",
  "requestScope": "Review the read processing change"
}
```

Only one review can be active per scope. If a review is already running you will be told which one and when it started, rather than getting a second review racing the first. If a review breaks mid-flight, inspect the lock and release it:

```bash
npx opencode-multireview unlock <review-id>
```

Locks never expire on their own, and fencing stops an abandoned run from writing results after you have recovered. Use `--force` only when you are sure, and only in a non-interactive environment.

## Working with past reviews

Any agent can read history directly with the `mmar_list_reviews` and `mmar_get_findings` tools — no new review round required. Both default to the current worktree; pass the canonical absolute Git worktree root to read another one. These tools are read-only: no database paths, no SQL, no writes, no lock ownership.

For a human-readable Markdown version, use the CLI:

```bash
npx opencode-multireview list [--all-projects] [--json]
npx opencode-multireview export <review-id> [--round <round-id>] [--output <path>]
npx opencode-multireview unlock <review-id> [--force]
```

Exports are deterministic and can target the latest round or any earlier one. Rounds are immutable, so an old export stays reproducible. `--output` writes atomically.

Agents never touch `REVIEW_FINDINGS.md` or any other Markdown findings file. SQLite is the source of truth; Markdown is only ever something you ask for explicitly.

### Dismissing findings

Ask to dismiss a finding and the plugin records the decision against the latest completed round, with the reason you gave. It does not rewrite history — the original finding and its hash are preserved, and the dismissal is stored as an override on top. Later rounds re-check dismissed findings against the current code: if your reason still holds, the finding stays dismissed; if the code has moved on, it comes back for fresh adjudication.

For an explicit disposition, pass the finding ID, disposition, and (for `ignored`) a non-empty reason. Include the canonical `worktreePath` when operating outside the current worktree.

## Storage and configuration

The database is created on first use and upgraded with packaged, checksummed, forward-only migrations. Default location:

- macOS: `~/Library/Application Support/opencode-multireview/reviews.sqlite`
- Windows: `%LOCALAPPDATA%/opencode-multireview/reviews.sqlite`
- Linux and others: `$XDG_DATA_HOME/opencode-multireview/reviews.sqlite`, falling back to `~/.local/share/opencode-multireview/reviews.sqlite`

It holds review identity, immutable rounds, findings, dismissal overrides, open questions, and lock metadata. It does **not** store fetched ticket or file content, full diffs, transcripts, or Markdown.

Models are configured per lane in `~/.config/opencode/multireview-plugin.json`. The keys are `coordinator`, `correctness`, `codestyle`, `testing`, and `intent`. Plugin options can override the config path and model choices.

## Development

Requires Node `>=24.15.0`.

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```

The test suite is deterministic and never calls a paid or live model. Live-model routing has to be verified by hand.

## Publishing

Releases go to npm through a GitHub Actions workflow using npm trusted publishing (OIDC), triggered by pushing a `vX.Y.Z` tag. The same workflow creates the GitHub Release.

```bash
npm run release
npm run release:dry-run
```

## License

MIT
