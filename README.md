# opencode-multireview-plugin

Local-first, npm-ready OpenCode plugin that bundles the `multireview` agent set and two Plannotator-backed review skills:

- `multireview-explainer`
- `multireview-diff`

The package injects the coordinator and four specialists directly through the OpenCode config hook. Bundled skills are installed by the package `postinstall` script, which copies them into `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills`.

## What multireview does

`@multireview` is an adversarial code review coordinator. By default it spawns four specialist reviewers in parallel, each scoped to a single concern and blind to the others' findings:

- **`multireview_correctness`** — logic soundness, edge cases, error handling, concurrency, performance, and OWASP-style security issues.
- **`multireview_codestyle`** — naming, function design, comments, DRY violations, and file/code organisation.
- **`multireview_testing`** — unit and integration test coverage for the changed code, plus test-quality anti-patterns (asserting on mocks, hardcoded sleeps, over-testing).
- **`multireview_intent`** — comparison with authoritative plans, specifications, tickets, and recorded decisions, distinguishing confirmed drift from unresolved evidence. Its default model is `github-copilot/claude-opus-4.8`.

Each specialist reviews only the given change scope (uncommitted changes, a branch diff, or a PR) and returns structured findings with a severity, exact code location, and justification — no fixes, no fluff, no praise. The configured default roster is `codestyle`, `correctness`, `testing`, and `intent`; all four specialists are registered even if a roster omits one, so a review can explicitly request it.

The coordinator then acts as final arbiter: it discards hallucinated, out-of-scope, or overly pedantic findings, merges duplicates across reviewers, and writes everything to `REVIEW_FINDINGS.md` in the repo root (git-excluded), split into `## Valid Findings`, `## Intent Uncertainties`, and `## Ignored Findings`. Confirmed intent drift is an impact-rated `INTENT` finding. Missing, inaccessible, contradictory, or insufficient intent evidence is an uncertainty with an answerable clarification question, not a guessed finding. Every ignored finding carries a one-line `Wontfix:` justification so later runs don't re-flag it.

## Reviewer routing and intent evidence

The `enabled_agents` roster accepts only these short keys: `codestyle`, `correctness`, `testing`, and `intent`. File configuration and plugin tuple options use replacement semantics in this order: defaults, local JSON, then tuple options. Entries retain their first-seen order and are deduplicated. Unknown entries are warned about and ignored; an all-invalid non-empty roster warns and becomes `[]`. An explicit `[]` deliberately selects no specialists. An empty effective roster leaves `REVIEW_FINDINGS.md` untouched.

File configuration example:

```json
{
  "enabled_agents": ["correctness", "testing", "intent"]
}
```

Tuple options can replace that roster:

```json
[
  "opencode-multireview-plugin",
  { "enabled_agents": ["intent"] }
]
```

Per-review instructions are applied after configuration: `only` replaces the roster, `include` adds to it, and `skip` removes reviewers last. Excluding `intent` bypasses intent-source preflight. When `intent` is selected and the request says an authoritative plan, specification, ticket, or recorded decision exists, the caller must provide content or a resolvable reference before any specialist starts. This is a whole-review refusal and leaves the report untouched. A supplied reference passes preflight even if it later cannot be fetched; that failure becomes a review-time uncertainty while independent findings continue.

For local review, provide an explicit plan path or content and any phase/PR-slice identifier in the normal review scope; plans are never auto-discovered. Intent review evaluates only that slice and does not flag later-slice work unless it invalidates the current slice. For remote PRs, caller-supplied acceptance criteria and recorded decisions outrank PR descriptions and linked issues, which outrank repository docs, commits, and finally implementation/tests as non-authoritative claims. Confirmed contradictions become `INTENT` findings; plausible concerns become uncertainties.

The coordinator returns `complete`, `partial`, or `blocked` status with unresolved uncertainty IDs and never asks users directly or hands work to `@fixer`. Valid findings that depend on uncertainty retain a trailing `**Blocked by intent:** MULTIREVIEW-UNCERTAINTY-n` marker and remain visible, but they are not fixer inputs. Skills surface questions to an interactive caller, wait for supplied answers/evidence, then invoke an intent-only clarification rerun. The rerun preserves non-intent output and replaces/reconciles intent output. Independent findings can be triaged and handed off while blocked findings wait.

From there, two optional skills turn findings into an interactive review pass using [Plannotator](https://github.com/plannotator/plannotator):

- **`multireview-explainer`** renders the findings and a narrative PR summary as a static HTML page. Reviewers select text and leave native comments (including `wontfix`) directly on findings.
- **`multireview-diff`** instead preloads findings as line comments in Plannotator's native git-diff UI, so reviewers work against the real file tree and diff rather than a rendered page.

Both skills triage the human feedback back into `REVIEW_FINDINGS.md` — confirming, dismissing, or re-scoping findings — and hand the confirmed valid findings off to a fixer agent to implement.

## Install

```bash
cd ~/.config/opencode
npm install opencode-multireview-plugin
```

Then configure OpenCode with Plannotator first:

```json
{
  "plugin": [
    ["@plannotator/opencode@latest", { "workflow": "all-agents" }],
    "opencode-multireview-plugin"
  ]
}
```

Restart OpenCode after changing plugin configuration.

## Install from a local checkout

For development or before a version is published, install directly from a local path:

```bash
cd ~/.config/opencode
npm install /path/to/opencode-multireview-plugin
```

Or reference the built plugin file directly:

```json
{
  "plugin": [
    ["@plannotator/opencode@latest", { "workflow": "all-agents" }],
    "file:///path/to/opencode-multireview-plugin/dist/index.js"
  ]
}
```


## Bundled skills

The bundled skills are copied during `npm install`, respecting `$XDG_CONFIG_HOME` when set:

- `~/.config/opencode/skills/multireview-explainer/SKILL.md`
- `~/.config/opencode/skills/multireview-diff/SKILL.md`

## Plannotator requirement

This plugin depends on Plannotator but does not vendor it. By default it fails during the config hook if `@plannotator/opencode` is not present in `cfg.plugin`. The bundled skills also expect the `plannotator` CLI to be available on `PATH`.

For development only, the runtime check can be disabled:

```json
{
  "plannotator": {
    "requirePlugin": false
  }
}
```

## Config overrides

Defaults:

```json
{
  "models": {
    "coordinator": "github-copilot/claude-opus-4.8",
    "codestyle": "github-copilot/claude-sonnet-5",
    "correctness": "github-copilot/gpt-5.4",
    "testing": "github-copilot/gemini-3.5-flash",
    "intent": "github-copilot/claude-opus-4.8"
  },
  "enabled_agents": ["codestyle", "correctness", "testing", "intent"],
  "plannotator": {
    "requirePlugin": true
  }
}
```

Create `~/.config/opencode/multireview-plugin.json` to override them locally:

```json
{
  "models": {
    "correctness": "github-copilot/gpt-5.2"
  }
}
```

Plugin tuple options override the local file:

```json
{
  "plugin": [
    ["@plannotator/opencode@latest", { "workflow": "all-agents" }],
    [
      "opencode-multireview-plugin",
      {
        "configPath": "~/.config/opencode/multireview-plugin.json",
        "models": { "testing": "github-copilot/gemini-3.1-pro-preview" },
        "enabled_agents": ["correctness", "intent"]
      }
    ]
  ]
}
```

## CLI helpers

The skills call package bins rather than absolute local paths:

- `opencode-multireview-parse-findings`
- `opencode-multireview-build-explainer`
- `opencode-multireview-build-code-annotations`
- `opencode-multireview-parse-findings partition-actionable <findings.json>` — partitions valid findings into actionable and intent-blocked inputs immediately before fixer handoff.

Overriding the `multireview` coordinator prompt replaces these routing, preflight, evidence, report, status, and caller-contract instructions. A replacement prompt is responsible for preserving equivalent behavior if it still uses the bundled specialists.

## Development

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```

## CI

GitHub Actions runs `.github/workflows/ci.yml` on pushes to `main` and on pull requests:

```bash
npm install
npm test
```

## Publishing

Releases are published to npm via a GitHub Actions workflow (`.github/workflows/publish.yml`) using npm's trusted publishing (OIDC), triggered when a `vX.Y.Z` tag is pushed. The same workflow also creates the GitHub Release automatically. No long-lived npm token is stored in the repository.

Cut releases with `release-it`, which bumps `package.json`, updates `CHANGELOG.md`, and creates and pushes the `vX.Y.Z` tag:

```bash
npm run release
```

To preview the release without changing anything:

```bash
npm run release:dry-run
```

Once the tag is pushed, `.github/workflows/publish.yml` creates the GitHub Release, builds, tests, and publishes the package to npm.
