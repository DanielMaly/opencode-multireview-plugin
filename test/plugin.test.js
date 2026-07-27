import test from "node:test";
import assert from "node:assert/strict";
import { MultireviewPlugin } from "../dist/index.js";

test("initializes and injects all agents without a companion plugin", async () => {
  const plugin = await MultireviewPlugin({}, { configPath: "/nonexistent/multireview-plugin.json" });
  const cfg = { agent: {} };

  await plugin.config(cfg);

  assert.deepEqual(Object.keys(cfg.agent).sort(), [
    "mmar_codestyle",
    "mmar_correctness",
    "mmar_intent",
    "mmar_orchestrator",
    "mmar_testing",
  ]);
});

test("registers agents without removing existing config", async () => {
  const plugin = await MultireviewPlugin({}, { configPath: "/nonexistent/multireview-plugin.json" });
  const cfg = {
    agent: {
      existing_agent: { model: "keep-me" },
      mmar_orchestrator: { model: "user-model", permission: { bash: "allow" }, tools: { mmar_begin: false } },
    },
  };

  await plugin.config(cfg);

  assert.equal(cfg.agent.existing_agent.model, "keep-me");
  assert.equal(cfg.agent.mmar_orchestrator.model, "user-model");
  assert.equal(cfg.agent.mmar_orchestrator.permission.bash, "deny");
  assert.deepEqual(cfg.agent.mmar_orchestrator.tools, { mmar_begin: true, mmar_complete: true });
  assert.equal(cfg.agent.mmar_correctness.model, "github-copilot/gpt-5.4");
});

test("injects model and variant into an absent agent", async () => {
  const plugin = await MultireviewPlugin({}, {
    configPath: "/tmp/opencode-multireview-plugin-variant-test.json",
    models: { correctness: { model: "review-model", variant: "thorough" } },
  });
  const cfg = { agent: {} };

  await plugin.config(cfg);

  assert.equal(cfg.agent.mmar_correctness.model, "review-model");
  assert.equal(cfg.agent.mmar_correctness.variant, "thorough");
});

test("preserves explicit user agent model and variant", async () => {
  const plugin = await MultireviewPlugin({}, {
    configPath: "/tmp/opencode-multireview-plugin-user-agent-test.json",
    models: { correctness: { model: "review-model", variant: "thorough" } },
  });
  const cfg = {
    agent: { mmar_correctness: { model: "user-model", variant: "user-variant" } },
  };

  await plugin.config(cfg);

  assert.equal(cfg.agent.mmar_correctness.model, "user-model");
  assert.equal(cfg.agent.mmar_correctness.variant, "user-variant");
});

test("keeps persistence tools exclusive to the orchestrator", async () => {
  const plugin = await MultireviewPlugin({}, { configPath: "/nonexistent/multireview-plugin.json" });
  const cfg = { agent: {} };

  await plugin.config(cfg);

  assert.deepEqual(cfg.agent.mmar_orchestrator.permission, {
    read: "allow",
    task: "allow",
    bash: "deny",
  });
  assert.deepEqual(cfg.agent.mmar_orchestrator.tools, { mmar_begin: true, mmar_complete: true });
  for (const name of ["mmar_correctness", "mmar_codestyle", "mmar_testing", "mmar_intent"]) {
    assert.equal(cfg.agent[name].tools.mmar_begin, false);
    assert.equal(cfg.agent[name].tools.mmar_complete, false);
  }
});

test("does not allow existing config to escalate bundled security controls", async () => {
  const plugin = await MultireviewPlugin({}, { configPath: "/nonexistent/multireview-plugin.json" });
  const cfg = {
    agent: {
      mmar_correctness: {
        permission: { bash: "allow", edit: "allow" },
        tools: { mmar_begin: true, mmar_complete: true },
      },
      mmar_orchestrator: {
        permission: { bash: "allow" },
        tools: { mmar_begin: false, mmar_complete: false },
      },
    },
  };

  await plugin.config(cfg);

  assert.equal(cfg.agent.mmar_correctness.permission.bash, "allow");
  assert.equal(cfg.agent.mmar_correctness.permission.edit, "deny");
  assert.deepEqual(cfg.agent.mmar_correctness.tools, { mmar_begin: false, mmar_complete: false });
  assert.equal(cfg.agent.mmar_orchestrator.permission.bash, "deny");
  assert.deepEqual(cfg.agent.mmar_orchestrator.tools, { mmar_begin: true, mmar_complete: true });
});
