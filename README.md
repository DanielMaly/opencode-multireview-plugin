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
    "coordinator": "github-copilot/claude-opus-4.6",
    "codestyle": "github-copilot/claude-sonnet-4.6",
    "correctness": "github-copilot/gpt-5.2",
    "testing": "github-copilot/gemini-3.1-pro-preview"
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

## Publishing

Releases are published to npm via a GitHub Actions workflow (`.github/workflows/publish.yml`) using npm's trusted publishing (OIDC), triggered when a GitHub Release is published. No long-lived npm token is stored in the repository.

To cut a release: bump `version` in `package.json`, merge to `main`, then create a matching GitHub Release/tag (e.g. `v0.2.0`). The workflow builds, tests, and publishes automatically.
