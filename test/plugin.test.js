import test from "node:test";
import assert from "node:assert/strict";
import { MultireviewPlugin } from "../dist/index.js";

test("fails when Plannotator plugin is not configured by default", async () => {
  const plugin = await MultireviewPlugin({}, { configPath: "/nonexistent/multireview-plugin.json" });
  const cfg = { plugin: ["opencode-multireview-plugin"] };

  await assert.rejects(() => plugin.config(cfg), /requires @plannotator\/opencode/);
});

test("registers agents without removing existing config", async () => {
  const plugin = await MultireviewPlugin({}, { configPath: "/nonexistent/multireview-plugin.json" });
  const cfg = {
    plugin: ["opencode-multireview-plugin", ["@plannotator/opencode@latest", { workflow: "all-agents" }]],
    agent: {
      existing_agent: { model: "keep-me" },
      multireview: { model: "user-model", permission: { bash: "allow" } },
    },
  };

  await plugin.config(cfg);

  assert.equal(cfg.agent.existing_agent.model, "keep-me");
  assert.equal(cfg.agent.multireview.model, "user-model");
  assert.equal(cfg.agent.multireview.permission.bash, "allow");
  assert.equal(cfg.agent.multireview_correctness.model, "github-copilot/gpt-5.2");
});

test("can disable the Plannotator config check for development", async () => {
  const plugin = await MultireviewPlugin(
    {},
    { configPath: "/nonexistent/multireview-plugin.json", plannotator: { requirePlugin: false } },
  );
  const cfg = { plugin: ["opencode-multireview-plugin"] };

  await plugin.config(cfg);

  assert.ok(cfg.agent.multireview_testing);
});
