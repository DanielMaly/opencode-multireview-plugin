# opencode-multireview-plugin

Local-first, npm-ready OpenCode plugin that bundles the `multireview` agent set and two Plannotator-backed review skills:

- `multireview-explainer`
- `multireview-diff`

The package injects the four agents directly through the OpenCode config hook. Bundled skills are installed by the package `postinstall` script, which copies them into `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills`.

## What multireview does

`@multireview` is an adversarial code review coordinator. Invoking it spawns three specialist reviewers in parallel, each scoped to a single concern and blind to the others' findings:

- **`multireview_correctness`** — logic soundness, edge cases, error handling, concurrency, performance, and OWASP-style security issues.
- **`multireview_codestyle`** — naming, function design, comments, DRY violations, and file/code organisation.
- **`multireview_testing`** — unit and integration test coverage for the changed code, plus test-quality anti-patterns (asserting on mocks, hardcoded sleeps, over-testing).

Each specialist reviews only the given change scope (uncommitted changes, a branch diff, or a PR) and returns structured findings with a severity, exact code location, and justification — no fixes, no fluff, no praise.

The coordinator then acts as final arbiter: it discards hallucinated, out-of-scope, or overly pedantic findings, merges duplicates across reviewers, and writes everything to `REVIEW_FINDINGS.md` in the repo root (git-excluded), split into `## Valid Findings` and `## Ignored Findings`. Every ignored finding carries a one-line `Wontfix:` justification so later runs don't re-flag it.

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
    "testing": "github-copilot/gemini-3.5-flash"
  },
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
        "models": { "testing": "github-copilot/gemini-3.1-pro-preview" }
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
