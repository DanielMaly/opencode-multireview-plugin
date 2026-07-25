import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { loadMultireviewConfig } from "../dist/config.js";

test("uses defaults when no config file exists", () => {
  const config = loadMultireviewConfig({ configPath: "/tmp/opencode-multireview-plugin-missing.json" });

  assert.equal(config.models.coordinator, "github-copilot/claude-opus-4.8");
  assert.equal(config.models.codestyle, "github-copilot/claude-sonnet-5");
  assert.equal(config.models.correctness, "github-copilot/gpt-5.4");
  assert.equal(config.models.testing, "github-copilot/gemini-3.5-flash");
  assert.equal(config.models.intent, "github-copilot/claude-opus-4.8");
  assert.deepEqual(config.enabled_agents, ["codestyle", "correctness", "testing", "intent"]);
  assert.equal(config.plannotator.requirePlugin, true);
});

test("enabled_agents replaces local roster with tuple roster, preserving order and deduplicating", () => {
  const dir = mkdtempSync(join(tmpdir(), "multireview-plugin-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ enabled_agents: ["testing", "intent"] }), "utf8");

  try {
    const config = loadMultireviewConfig({
      configPath,
      enabled_agents: ["correctness", "correctness", "codestyle"],
    });

    assert.deepEqual(config.enabled_agents, ["correctness", "codestyle"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enabled_agents accepts an intentional empty roster and warns for unknown entries", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);

  try {
    const config = loadMultireviewConfig({
      configPath: "/tmp/opencode-multireview-plugin-missing.json",
      enabled_agents: ["unknown", "intent", "intent"],
    });
    assert.deepEqual(config.enabled_agents, ["intent"]);

    const empty = loadMultireviewConfig({
      configPath: "/tmp/opencode-multireview-plugin-missing.json",
      enabled_agents: [],
    });
    assert.deepEqual(empty.enabled_agents, []);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown reviewer keys/);
});

test("all-invalid enabled_agents warns and produces an empty roster", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);

  try {
    const config = loadMultireviewConfig({
      configPath: "/tmp/opencode-multireview-plugin-missing.json",
      enabled_agents: ["not-a-reviewer"],
    });
    assert.deepEqual(config.enabled_agents, []);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /unknown reviewer keys/);
  assert.match(warnings[1], /roster is empty/);
});

test("non-array enabled_agents warns and produces an empty roster", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);

  try {
    const config = loadMultireviewConfig({
      configPath: "/tmp/opencode-multireview-plugin-missing.json",
      enabled_agents: "intent",
    });
    assert.deepEqual(config.enabled_agents, []);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /enabled_agents must be an array/);
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
    assert.equal(config.models.coordinator, "github-copilot/claude-opus-4.8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
