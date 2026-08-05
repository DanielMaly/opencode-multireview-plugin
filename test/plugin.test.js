import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MultireviewPlugin, createMultireviewPlugin } from "../dist/index.js";
import { PersistentReviewLifecycle } from "../dist/storage/lifecycle.js";
import { ReviewStore } from "../dist/storage/reviews.js";

function identity(directory) {
  return {
    projectKey: "plugin-test-project",
    rootPath: directory,
    worktreePath: directory,
    headCommit: "head",
    isGit: false,
    baseRef: "base",
    baseCommit: "base-commit",
  };
}

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

test("describes the orchestrator scope and keeps specialist lanes internal", async () => {
  const plugin = await MultireviewPlugin({}, { configPath: "/nonexistent/multireview-plugin.json" });
  const cfg = { agent: {} };

  await plugin.config(cfg);

  assert.match(cfg.agent.mmar_orchestrator.description, /MMAR, multireview, and multi-model adversarial/);
  assert.match(cfg.agent.mmar_orchestrator.description, /pull requests, branches, commits, uncommitted worktrees, and custom changesets/);
  for (const name of ["mmar_correctness", "mmar_codestyle", "mmar_testing", "mmar_intent"]) {
    assert.match(cfg.agent[name].description, /Internal MMAR specialist lane/);
    assert.match(cfg.agent[name].prompt, /internal MMAR lane/);
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

test("registers plugin hooks, guards specialist tasks, and logs event diagnostics", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-multireview-plugin-hooks-"));
  try {
    const databasePath = join(directory, "reviews.sqlite");
    const store = new ReviewStore({ databasePath });
    const lifecycle = new PersistentReviewLifecycle({ databasePath });
    const logs = [];
    let logAttempts = 0;
    const plugin = await createMultireviewPlugin(lifecycle)({
      directory,
      worktree: directory,
      client: {
        app: {
          log: async (entry) => {
            logAttempts += 1;
            if (logAttempts === 1) throw new Error("log unavailable");
            logs.push(entry);
          },
        },
      },
    }, { configPath: "/nonexistent/multireview-plugin.json" });
    const cfg = { agent: {} };

    await plugin.config(cfg);
    assert.equal(typeof plugin.tool.mmar_begin, "object");
    assert.equal(typeof plugin["tool.execute.before"], "function");
    assert.equal(typeof plugin.event, "function");
    assert.ok(cfg.agent.mmar_orchestrator);

    const sessionID = "plugin-session";
    await assert.rejects(
      () => plugin["tool.execute.before"]({ tool: "task", sessionID, callID: "call" }, { args: { subagent_type: "mmar_correctness" } }),
      /active review lock/,
    );
    const review = store.begin({ identity: identity(directory), target: { kind: "custom", key: "plugin-review", label: "Plugin review" }, sessionID });
    await plugin["tool.execute.before"]({ tool: "task", sessionID, callID: "call" }, { args: { subagent_type: "mmar_correctness" } });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID } } });
    await plugin.event({ event: { type: "session.error", properties: { sessionID } } });
    await plugin.event({ event: { type: "session.error", properties: { sessionID } } });

    assert.equal(logAttempts, 2);
    assert.deepEqual(logs, [{
      body: {
        service: "opencode-multireview-plugin",
        level: "warn",
        message: `MMAR review ${review.reviewId} needs attention after session.error; completion remains available for session ${sessionID}.`,
        extra: { event: "session.error", reviewId: review.reviewId, sessionID },
      },
      query: { directory },
    }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
