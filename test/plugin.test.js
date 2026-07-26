import test from "node:test";
import assert from "node:assert/strict";
import { MultireviewPlugin } from "../dist/index.js";

test("initializes and injects all agents without a companion plugin", async () => {
  const plugin = await MultireviewPlugin({}, { configPath: "/nonexistent/multireview-plugin.json" });
  const cfg = { agent: {} };

  await plugin.config(cfg);

  assert.deepEqual(Object.keys(cfg.agent).sort(), [
    "multireview",
    "multireview_codestyle",
    "multireview_correctness",
    "multireview_testing",
  ]);
});

test("registers agents without removing existing config", async () => {
  const plugin = await MultireviewPlugin({}, { configPath: "/nonexistent/multireview-plugin.json" });
  const cfg = {
    agent: {
      existing_agent: { model: "keep-me" },
      multireview: { model: "user-model", permission: { bash: "allow" } },
    },
  };

  await plugin.config(cfg);

  assert.equal(cfg.agent.existing_agent.model, "keep-me");
  assert.equal(cfg.agent.multireview.model, "user-model");
  assert.equal(cfg.agent.multireview.permission.bash, "allow");
  assert.equal(cfg.agent.multireview_correctness.model, "github-copilot/gpt-5.4");
});

test("injects model and variant into an absent agent", async () => {
  const plugin = await MultireviewPlugin({}, {
    configPath: "/tmp/opencode-multireview-plugin-variant-test.json",
    models: { correctness: { model: "review-model", variant: "thorough" } },
  });
  const cfg = { agent: {} };

  await plugin.config(cfg);

  assert.equal(cfg.agent.multireview_correctness.model, "review-model");
  assert.equal(cfg.agent.multireview_correctness.variant, "thorough");
});

test("preserves explicit user agent model and variant", async () => {
  const plugin = await MultireviewPlugin({}, {
    configPath: "/tmp/opencode-multireview-plugin-user-agent-test.json",
    models: { correctness: { model: "review-model", variant: "thorough" } },
  });
  const cfg = {
    agent: { multireview_correctness: { model: "user-model", variant: "user-variant" } },
  };

  await plugin.config(cfg);

  assert.equal(cfg.agent.multireview_correctness.model, "user-model");
  assert.equal(cfg.agent.multireview_correctness.variant, "user-variant");
});
