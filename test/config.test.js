import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { loadMultireviewConfig } from "../dist/config.js";

test("uses defaults when no config file exists", () => {
  const config = loadMultireviewConfig({ configPath: "/tmp/opencode-multireview-plugin-missing.json" });

  assert.equal(config.models.coordinator, "github-copilot/claude-opus-4.6");
  assert.equal(config.models.codestyle, "github-copilot/claude-sonnet-4.6");
  assert.equal(config.plannotator.requirePlugin, true);
});

test("local config overrides defaults and tuple options override local config", () => {
  const dir = mkdtempSync(join(tmpdir(), "multireview-plugin-"));
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ models: { correctness: "local-correctness", testing: "local-testing" } }),
    "utf8",
  );

  try {
    const config = loadMultireviewConfig({
      configPath,
      models: { testing: "option-testing" },
    });

    assert.equal(config.models.correctness, "local-correctness");
    assert.equal(config.models.testing, "option-testing");
    assert.equal(config.models.coordinator, "github-copilot/claude-opus-4.6");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
