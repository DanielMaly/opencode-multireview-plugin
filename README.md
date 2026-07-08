# opencode-multireview-plugin

Local-first, npm-ready OpenCode plugin that bundles the `multireview` agent set and two Plannotator-backed review skills:

- `multireview-explainer`
- `multireview-diff`

The package injects the four agents directly through the OpenCode config hook. Bundled skills are installed by the package `postinstall` script, which copies them into `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills`.

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
