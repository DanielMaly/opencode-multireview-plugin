import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { loadMultireviewConfig } from "../dist/config.js";
import { DEFAULT_CONFIG, REVIEWER_KEYS } from "../dist/defaults.js";

test("shipped defaults contain every registered reviewer", () => {
  const shipped = JSON.parse(readFileSync(new URL("../config/multireview-plugin.defaults.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(shipped.models).sort(), [...REVIEWER_KEYS].sort());
  for (const key of REVIEWER_KEYS) assert.equal(shipped.models[key], DEFAULT_CONFIG.models[key].model);
});

test("uses defaults when no config file exists", () => {
  const config = loadMultireviewConfig({ configPath: "/tmp/opencode-multireview-plugin-missing.json" });

  assert.deepEqual(config.models.coordinator, { model: "github-copilot/claude-opus-5" });
  assert.deepEqual(config.models.codestyle, { model: "github-copilot/claude-sonnet-5" });
  assert.deepEqual(config.models.correctness, { model: "github-copilot/gpt-5.6-sol" });
  assert.deepEqual(config.models.testing, { model: "github-copilot/gemini-3.7-flash" });
  assert.deepEqual(config.models.intent, { model: "github-copilot/claude-opus-5" });
});

test("ignores legacy unknown configuration keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "multireview-plugin-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ plannotator: { requirePlugin: true } }), "utf8");

  try {
    assert.deepEqual(loadMultireviewConfig({ configPath }), {
      models: {
        coordinator: { model: "github-copilot/claude-opus-5" },
        codestyle: { model: "github-copilot/claude-sonnet-5" },
        correctness: { model: "github-copilot/gpt-5.6-sol" },
        testing: { model: "github-copilot/gemini-3.7-flash" },
        intent: { model: "github-copilot/claude-opus-5" },
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizes legacy string and object model overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "multireview-plugin-"));
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ models: { correctness: "local-correctness", testing: { model: "local-testing", variant: "fast" } } }),
    "utf8",
  );

  try {
    const config = loadMultireviewConfig({
      configPath,
      models: { testing: "option-testing" },
    });

    assert.deepEqual(config.models.correctness, { model: "local-correctness" });
    assert.deepEqual(config.models.testing, { model: "option-testing" });
    assert.deepEqual(config.models.coordinator, { model: "github-copilot/claude-opus-5" });
    assert.deepEqual(config.models.intent, { model: "github-copilot/claude-opus-5" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selects a partial profile and applies file and tuple precedence atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "multireview-plugin-"));
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      profile: "fast",
      profiles: {
        fast: {
          coordinator: { model: "profile-coordinator", variant: "profile-variant" },
          correctness: "profile-correctness",
        },
      },
      models: {
        coordinator: "file-coordinator",
        testing: { model: "file-testing", variant: "file-variant" },
      },
    }),
    "utf8",
  );

  try {
    const config = loadMultireviewConfig({
      configPath,
      models: { testing: "tuple-testing" },
    });

    assert.deepEqual(config.models.coordinator, { model: "file-coordinator" });
    assert.deepEqual(config.models.correctness, { model: "profile-correctness" });
    assert.deepEqual(config.models.testing, { model: "tuple-testing" });
    assert.deepEqual(config.models.codestyle, { model: "github-copilot/claude-sonnet-5" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uses a non-empty environment profile before the file profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "multireview-plugin-"));
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      profile: "file-profile",
      profiles: {
        "file-profile": { coordinator: "file-profile-model" },
        "env-profile": { coordinator: "env-profile-model" },
      },
    }),
    "utf8",
  );
  const previous = process.env.OPENCODE_MULTIREVIEW_PROFILE;

  try {
    process.env.OPENCODE_MULTIREVIEW_PROFILE = " env-profile ";
    assert.deepEqual(loadMultireviewConfig({ configPath }).models.coordinator, { model: "env-profile-model" });

    process.env.OPENCODE_MULTIREVIEW_PROFILE = "   ";
    assert.deepEqual(loadMultireviewConfig({ configPath }).models.coordinator, { model: "file-profile-model" });
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_MULTIREVIEW_PROFILE;
    else process.env.OPENCODE_MULTIREVIEW_PROFILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("warns and falls back to shipped defaults for an unknown profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "multireview-plugin-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ profile: "missing", models: { testing: "file-testing" } }), "utf8");
  const warnings = [];
  const originalWarn = console.warn;

  try {
    console.warn = (message) => warnings.push(message);
    const config = loadMultireviewConfig({ configPath, models: { correctness: "tuple-correctness" } });

    assert.deepEqual(config.models.coordinator, { model: "github-copilot/claude-opus-5" });
    assert.deepEqual(config.models.intent, { model: "github-copilot/claude-opus-5" });
    assert.deepEqual(config.models.testing, { model: "file-testing" });
    assert.deepEqual(config.models.correctness, { model: "tuple-correctness" });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /missing/);
  } finally {
    console.warn = originalWarn;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects malformed model and profile configuration", () => {
  const cases = [
    [{ models: [] }, /models.*must be an object/],
    [{ models: { correctness: [] } }, /models\.correctness.*non-empty string or an object/],
    [{ models: { correctness: "" } }, /models\.correctness.*non-empty string/],
    [{ models: { correctness: {} } }, /models\.correctness.*non-empty model string/],
    [{ models: { correctness: { model: "model", variant: "" } } }, /variant.*non-empty string/],
    [{ models: { unknown: "model" } }, /unknown reviewer key/],
    [{ profiles: [] }, /profiles.*must be an object/],
    [{ profiles: { fast: [] } }, /profiles\.fast.*must be an object/],
    [{ profiles: { default: {} } }, /default.*reserved/],
    [{ profiles: { fast: { unknown: "model" } } }, /unknown reviewer key/],
  ];

  for (const [value, message] of cases) {
    const dir = mkdtempSync(join(tmpdir(), "multireview-plugin-"));
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify(value), "utf8");
    try {
      assert.throws(() => loadMultireviewConfig({ configPath }), message);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("rejects unknown tuple reviewer keys", () => {
  assert.throws(
    () => loadMultireviewConfig({ configPath: "/nonexistent/multireview-plugin.json", models: { unknown: "model" } }),
    /unknown reviewer key/,
  );
});
