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

Then register the plugin in your OpenCode configuration if it is not already loaded, and restart OpenCode:

```json
{
  "plugin": ["opencode-multireview-plugin"]
}
```

That is all. The plugin registers its agents and the `mmar` skill directly with OpenCode — no manual skill copying needed.

### Standalone skill install (optional)

You only need this to run the skill without the plugin loaded, or to repair a broken copy:

```bash
opencode-multireview skill install --global   # ~/.config/opencode/skills/mmar/SKILL.md
opencode-multireview skill install --project  # <project>/.opencode/skills/mmar/SKILL.md
```

`XDG_CONFIG_HOME` is respected for global installs.

Each installed copy gets a `.provenance.json` sidecar recording package name, version, and checksum. Missing copies are created and outdated plugin-owned copies are updated. If you have edited the file, or it was not installed by this plugin, it is left alone — uninstalling never deletes your own work.

## Running a review

Ask for a review in OpenCode ("run MMAR on this branch", "multireview this PR") and the `mmar` skill takes over. It works out what you want reviewed, resolves the base ref, and hands a single request to the `mmar_orchestrator` agent.

You can review a **pull request, branch, commit, uncommitted worktree, or custom changeset**. A resolvable base ref is required; without one the review stops with an error rather than guessing.

By default three lanes run: correctness, code style, and testing. Add an intent reference — a Jira key, a ticket URL, or a local file path — and a fourth lane checks the change against what was actually asked for. You can also pick lanes explicitly for a narrower review.

Each round comes back with a status:

- **complete** — nothing unresolved.
- **partial** — some questions remain, but there are findings you can act on now.
- **blocked** — questions remain and nothing is actionable until you answer them.

Answer any clarification questions and run another round on the same scope to refine the result.

### Scope isolation and locking

A review is identified by project, normalized target, and resolved base commit. Change the target or the base and you get a fresh review; findings never leak between unrelated scopes.

Only one review can be active per scope. If a review is already running you will be told which one and when it started, rather than getting a second review racing the first. If a review breaks mid-flight, inspect the lock and release it:

```bash
opencode-multireview unlock <review-id>
```

Locks never expire on their own, and fencing stops an abandoned run from writing results after you have recovered. Use `--force` only when you are sure, and only in a non-interactive environment.

## Working with past reviews

Any agent can read history directly with the `mmar_list_reviews` and `mmar_get_findings` tools — no new review round required. Both default to the current worktree; pass an absolute Git worktree root to read another one. These tools are read-only: no database paths, no SQL, no writes, no lock ownership.

For a human-readable Markdown version, use the CLI:

```bash
opencode-multireview list [--all-projects] [--json]
opencode-multireview export <review-id> [--round <round-id>] [--output <path>]
opencode-multireview unlock <review-id> [--force]
```

Exports are deterministic and can target the latest round or any earlier one. Rounds are immutable, so an old export stays reproducible. `--output` writes atomically.

Agents never touch `REVIEW_FINDINGS.md` or any other Markdown findings file. SQLite is the source of truth; Markdown is only ever something you ask for explicitly.

### Dismissing findings

Ask to dismiss a finding and the plugin records the decision against the latest completed round, with the reason you gave. It does not rewrite history — the original finding and its hash are preserved, and the dismissal is stored as an override on top. Later rounds re-check dismissed findings against the current code: if your reason still holds, the finding stays dismissed; if the code has moved on, it comes back for fresh adjudication.

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
