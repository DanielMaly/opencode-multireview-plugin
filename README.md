# opencode-multireview-plugin

Local-first, npm-ready OpenCode plugin bundling four adversarial multireview agents and a review-findings parser.

## What multireview does

`@multireview` is an adversarial code review coordinator. It spawns three specialist reviewers in parallel, each scoped to a single concern and blind to the others' findings:

- **`multireview_correctness`** — logic soundness, edge cases, error handling, concurrency, performance, and OWASP-style security issues.
- **`multireview_codestyle`** — naming, function design, comments, DRY violations, and file/code organisation.
- **`multireview_testing`** — unit and integration test coverage for changed code, plus test-quality anti-patterns.

The coordinator acts as final arbiter: it discards hallucinated, out-of-scope, or overly pedantic findings, merges duplicates, and writes the result to `REVIEW_FINDINGS.md` in the repository root. Findings are split into `## Valid Findings` and `## Ignored Findings`; every ignored finding carries a one-line `Wontfix:` justification.

## Install

```bash
cd ~/.config/opencode
npm install opencode-multireview-plugin
```

Add the plugin to OpenCode configuration:

```json
{
  "plugin": ["opencode-multireview-plugin"]
}
```

Restart OpenCode after changing plugin configuration.

## Install from a local checkout

```bash
cd ~/.config/opencode
npm install /path/to/opencode-multireview-plugin
```

Or reference the built plugin file directly:

```json
{
  "plugin": ["file:///path/to/opencode-multireview-plugin/dist/index.js"]
}
```

## Configuration

Defaults:

```json
{
  "models": {
    "coordinator": "github-copilot/claude-opus-4.8",
    "codestyle": "github-copilot/claude-sonnet-5",
    "correctness": "github-copilot/gpt-5.4",
    "testing": "github-copilot/gemini-3.5-flash"
  }
}
```

Create `~/.config/opencode/multireview-plugin.json` to override models locally:

```json
{
  "models": {
    "correctness": {
      "model": "github-copilot/gpt-5.4",
      "variant": "high"
    }
  }
}
```

Strings remain supported. Define reusable profiles in the same file and select one with `profile`:

```json
{
  "profile": "fast",
  "profiles": {
    "fast": {
      "coordinator": "github-copilot/claude-sonnet-5",
      "testing": { "model": "github-copilot/gemini-3.5-flash", "variant": "fast" }
    },
    "thorough": {
      "correctness": { "model": "github-copilot/gpt-5.4", "variant": "high" }
    }
  }
}
```

`OPENCODE_MULTIREVIEW_PROFILE` selects a non-empty environment value before the file's `profile`; an empty value is ignored. Precedence is shipped defaults, selected profile, file `models`, then tuple `models`. Each reviewer override replaces both its model and variant. The reserved `default` profile means the shipped baseline and cannot be defined under `profiles`.

An unknown selected profile warns and falls back to shipped defaults; file and tuple model overrides still apply. Invalid model/profile entries, including arrays, empty models or variants, unknown reviewers, and `profiles.default`, fail during config loading. Profile and model settings are read when the plugin loads, so restart OpenCode after changing them.

Plugin tuple options override the local file:

```json
{
  "plugin": [
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

Tuple options are limited to `configPath` and `models`; profiles are file configuration only.

## Findings parser

The package exposes the retained parser CLI:

```bash
opencode-multireview-parse-findings parse REVIEW_FINDINGS.md
```

It parses the `REVIEW_FINDINGS.md` contract and emits structured findings for downstream tooling. The source parser is also available at `assets/scripts/parse-review-findings.mjs`.

## Upgrade note

Package upgrades do not delete skill files copied by earlier package versions. If they are no longer needed, manually remove these directories:

- `~/.config/opencode/skills/multireview-explainer`
- `~/.config/opencode/skills/multireview-diff`

## Development

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```

## CI

GitHub Actions runs `.github/workflows/ci.yml` on pushes to `main` and on pull requests.

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
