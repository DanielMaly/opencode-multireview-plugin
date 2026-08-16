import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MultireviewPlugin, createMultireviewPlugin } from "../dist/index.js";
import { PersistentReviewLifecycle } from "../dist/storage/lifecycle.js";
import { ReviewStore } from "../dist/storage/reviews.js";
import { laneRegistry } from "../dist/lanes.js";

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

function specialistNames() {
  return laneRegistry.map((lane) => lane.specialistAgent)
}

async function configured(initial = {}) {
  const plugin = await MultireviewPlugin({}, { configPath: "/nonexistent/multireview-plugin.json" });
  await plugin.config(initial);
  return initial;
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
  assert.equal(cfg.agent.mmar_orchestrator.permission.bash, "allow");
  assert.deepEqual(cfg.agent.mmar_orchestrator.tools, { mmar_begin: true, mmar_complete: true, mmar_list_reviews: true, mmar_get_findings: true });
  assert.equal(cfg.agent.mmar_correctness.model, "github-copilot/gpt-5.6-sol");
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

test("keeps write tools exclusive while enabling read tools for every bundled specialist", async () => {
  const plugin = await MultireviewPlugin({}, { configPath: "/nonexistent/multireview-plugin.json" });
  const cfg = { agent: {} };

  await plugin.config(cfg);

  assert.deepEqual(cfg.agent.mmar_orchestrator.permission, {
    read: "allow",
    task: { "*": "deny", ...Object.fromEntries(specialistNames().map((name) => [name, "allow"])) },
    bash: "allow",
    edit: "deny",
  });
  assert.deepEqual(cfg.agent.mmar_orchestrator.tools, { mmar_begin: true, mmar_complete: true, mmar_list_reviews: true, mmar_get_findings: true });
  for (const name of ["mmar_correctness", "mmar_codestyle", "mmar_testing", "mmar_intent"]) {
    assert.equal(cfg.agent[name].tools.mmar_begin, false);
    assert.equal(cfg.agent[name].tools.mmar_complete, false);
    assert.equal(cfg.agent[name].tools.mmar_list_reviews, false);
    assert.equal(cfg.agent[name].tools.mmar_get_findings, true);
  }
});

test("hides registry specialists and preserves the visible orchestrator", async () => {
  const cfg = await configured({ agent: {} });
  assert.equal(cfg.agent.mmar_orchestrator.hidden, false);
  assert.equal(cfg.agent.mmar_orchestrator.mode, "all");
  for (const name of specialistNames()) {
    assert.equal(cfg.agent[name].hidden, true);
    assert.equal(cfg.agent[name].mode, "subagent");
  }
});

test("merges top-level task permissions for missing, string, and object rules", async () => {
  const names = specialistNames();
  const missing = await configured({});
  assert.deepEqual(missing.permission.task, Object.fromEntries(names.map((name) => [name, "deny"])));

  const wholeString = await configured({ permission: "allow" });
  assert.deepEqual(wholeString.permission, {
    "*": "allow",
    task: { "*": "allow", ...Object.fromEntries(names.map((name) => [name, "deny"])) },
  });

  const string = await configured({ permission: { task: "allow", read: "deny" } });
  assert.deepEqual(string.permission.task, { "*": "allow", ...Object.fromEntries(names.map((name) => [name, "deny"])) });
  assert.equal(string.permission.read, "deny");

  const object = await configured({ permission: { task: { "*": "allow", custom_agent: "deny" }, edit: "allow" } });
  assert.deepEqual(object.permission.task, { "*": "allow", custom_agent: "deny", ...Object.fromEntries(names.map((name) => [name, "deny"])) });
  assert.equal(object.permission.edit, "allow");
});

test("protects explicit non-orchestrator task overrides without adding absent overrides", async () => {
  const names = specialistNames();
  const cfg = await configured({ agent: {
    whole_string: { permission: "allow" },
    caller: { permission: { task: "allow", bash: "ask" } },
    no_override: { permission: { bash: "allow" } },
  } });
  assert.deepEqual(cfg.agent.whole_string.permission, {
    "*": "allow",
    task: { "*": "allow", ...Object.fromEntries(names.map((name) => [name, "deny"])) },
  });
  assert.deepEqual(cfg.agent.caller.permission.task, { "*": "allow", ...Object.fromEntries(names.map((name) => [name, "deny"])) });
  assert.equal(cfg.agent.caller.permission.bash, "ask");
  assert.equal(Object.hasOwn(cfg.agent.no_override.permission, "task"), false);
});

test("orchestrator task access is exactly the registered specialist allowlist", async () => {
  const names = specialistNames();
  const cfg = await configured({ agent: {
    mmar_orchestrator: { permission: { task: { "*": "allow", unrelated: "deny" }, edit: "allow" } },
  } });
  assert.deepEqual(cfg.agent.mmar_orchestrator.permission.task, { "*": "deny", ...Object.fromEntries(names.map((name) => [name, "allow"])) });
  assert.equal(cfg.agent.mmar_orchestrator.permission.edit, "allow");
});

test("preserves higher subagent depth and raises lower or missing values to two", async () => {
  assert.equal((await configured({})).subagent_depth, 2);
  assert.equal((await configured({ subagent_depth: 1 })).subagent_depth, 2);
  assert.equal((await configured({ subagent_depth: 5 })).subagent_depth, 5);
});

test("loads agent metadata and non-empty prompts for every bundled agent", async () => {
  const plugin = await MultireviewPlugin({}, { configPath: "/nonexistent/multireview-plugin.json" });
  const cfg = { agent: {} };

  await plugin.config(cfg);

  for (const [name, mode] of [
    ["mmar_orchestrator", "all"],
    ["mmar_correctness", "subagent"],
    ["mmar_codestyle", "subagent"],
    ["mmar_testing", "subagent"],
    ["mmar_intent", "subagent"],
  ]) {
    assert.equal(typeof cfg.agent[name].description, "string");
    assert.ok(cfg.agent[name].description.trim().length > 0);
    assert.equal(cfg.agent[name].mode, mode);
    assert.equal(typeof cfg.agent[name].prompt, "string");
    assert.ok(cfg.agent[name].prompt.trim().length > 0);
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
  assert.deepEqual(cfg.agent.mmar_correctness.tools, { mmar_begin: false, mmar_complete: false, mmar_list_reviews: false, mmar_get_findings: true });
  assert.equal(cfg.agent.mmar_orchestrator.permission.bash, "allow");
  assert.deepEqual(cfg.agent.mmar_orchestrator.tools, { mmar_begin: true, mmar_complete: true, mmar_list_reviews: true, mmar_get_findings: true });
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
