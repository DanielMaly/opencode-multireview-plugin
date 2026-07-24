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
  assert.equal(cfg.agent.multireview_correctness.model, "github-copilot/gpt-5.4");
  assert.equal(cfg.agent.multireview_intent.model, "github-copilot/claude-opus-4.8");
  assert.match(cfg.agent.multireview.prompt, /codestyle, correctness, testing, intent/);
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

test("registers omitted specialists and embeds the configured roster", async () => {
  const plugin = await MultireviewPlugin(
    {},
    {
      configPath: "/nonexistent/multireview-plugin.json",
      enabled_agents: ["intent"],
      plannotator: { requirePlugin: false },
    },
  );
  const cfg = { plugin: [], agent: {} };

  await plugin.config(cfg);

  assert.ok(cfg.agent.multireview_correctness);
  assert.ok(cfg.agent.multireview_codestyle);
  assert.ok(cfg.agent.multireview_testing);
  assert.ok(cfg.agent.multireview_intent);
  assert.match(cfg.agent.multireview.prompt, /intent/);
  assert.doesNotMatch(cfg.agent.multireview.prompt, /codestyle, correctness, testing, intent/);
});

test("coordinator prompt preserves the intent routing contracts", async () => {
  const plugin = await MultireviewPlugin(
    {},
    {
      configPath: "/nonexistent/multireview-plugin.json",
      plannotator: { requirePlugin: false },
    },
  );
  const cfg = { plugin: [], agent: {} };

  await plugin.config(cfg);

  const prompt = cfg.agent.multireview.prompt;
  assert.match(prompt, /If `intent` is absent, spawn the remaining roster without an intent-source preflight/);
  assert.match(prompt, /current-slice scope/);
  assert.match(prompt, /Do not flag work explicitly assigned to a later slice/);
  assert.match(prompt, /Never ask the user directly and never assume access to a question tool/);
  assert.match(prompt, /Return a concise status plus unresolved uncertainty IDs to the caller/);
});

test("coordinator prompt preserves the sharp general review workflow", async () => {
  const plugin = await MultireviewPlugin(
    {},
    {
      configPath: "/nonexistent/multireview-plugin.json",
      plannotator: { requirePlugin: false },
    },
  );
  const cfg = { plugin: [], agent: {} };

  await plugin.config(cfg);

  const prompt = cfg.agent.multireview.prompt;
  assert.match(prompt, /### Step 1: Select and spawn/);
  assert.match(prompt, /STRICTLY FORBIDDEN from fetching the entire diff[\s\S]*before completing this step/);
  assert.match(prompt, /Immediately spawn all specialists in the final effective roster concurrently/);
  assert.match(prompt, /### Step 2: Collect and arbitrate/);
  assert.match(prompt, /without bias/);
  assert.match(prompt, /validity, relevance, scope creep, current-slice scope, proof quality, and severity based on consequence\/impact/);
  assert.match(prompt, /Correctness, security, code style, testing, and intent are peer review domains/);
  assert.match(prompt, /do not frame general arbitration primarily through intent/);
  assert.match(prompt, /You may spawn dedicated explore subagents again after the initial specialists have returned/);
  assert.match(prompt, /Copy accepted valid findings verbatim/);
  assert.match(prompt, /Copy rejected findings verbatim into `Ignored Findings`/);
  assert.match(prompt, /append exactly one final line: `\*\*Wontfix:/);
});

test("an empty configured roster still registers every specialist", async () => {
  const plugin = await MultireviewPlugin(
    {},
    {
      configPath: "/nonexistent/multireview-plugin.json",
      enabled_agents: [],
      plannotator: { requirePlugin: false },
    },
  );
  const cfg = { plugin: [], agent: {} };

  await plugin.config(cfg);

  assert.ok(cfg.agent.multireview_correctness);
  assert.ok(cfg.agent.multireview_intent);
  assert.match(cfg.agent.multireview.prompt, /\(none\)/);
});
