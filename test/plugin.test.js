import test from "node:test";
import assert from "node:assert/strict";
import { createMultireviewPlugin, MultireviewPlugin } from "../dist/index.js";

function fakeContext({ options = { configPath: "/nonexistent/multireview-plugin.json" }, events = [] } = {}) {
  const registrations = { tools: [], agents: [], skills: [], hooks: [] };
  const context = {
    options,
    location: { directory: "/project/worktree", project: { directory: "/project/worktree" } },
    tool: {
      transform: async (callback) => {
        callback({ add: (definition) => registrations.tools.push(definition) });
        return { dispose: async () => {} };
      },
      hook: async (name, callback) => {
        registrations.hooks.push({ name, callback });
        return { dispose: async () => {} };
      },
    },
    agent: {
      transform: async (callback) => {
        const agents = {};
        callback({ get: () => undefined, update: (id, fn) => { agents[id] ??= {}; fn(agents[id]); } });
        registrations.agents.push(agents);
        return { dispose: async () => {} };
      },
    },
    skill: {
      transform: async (callback) => {
        callback({ get: () => undefined, add: (skill) => registrations.skills.push(skill) });
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
        },
      }),
    },
  };
  return { context, registrations };
}

const noopLifecycle = {
  activeReviewForSession: () => undefined,
  recordIncompleteDiagnosticMarker: () => ({ deduplicated: true }),
  releaseIncompleteDiagnosticMarker: () => {},
};

test("exports a V2 definition with a stable id and setup function", () => {
  assert.equal(MultireviewPlugin.id, "opencode-multireview-plugin");
  assert.equal(typeof MultireviewPlugin.setup, "function");
  assert.equal(Object.hasOwn(MultireviewPlugin, "server"), false);
});

test("registers exact V2 agent permissions and configured model references", async () => {
  const { context, registrations } = fakeContext({
    options: {
      configPath: "/nonexistent/multireview-plugin.json",
      models: { correctness: { model: "test-provider/test-model#inline", variant: "configured" } },
    },
  });
  const cleanup = await createMultireviewPlugin(noopLifecycle).setup(context);

  const agents = registrations.agents[0];
  assert.deepEqual(agents.mmar_orchestrator.permissions, [
    { action: "read", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "subagent", resource: "mmar_correctness", effect: "allow" },
    { action: "subagent", resource: "mmar_codestyle", effect: "allow" },
    { action: "subagent", resource: "mmar_testing", effect: "allow" },
    { action: "subagent", resource: "mmar_intent", effect: "allow" },
    { action: "mmar_begin", resource: "*", effect: "allow" },
    { action: "mmar_complete", resource: "*", effect: "allow" },
    { action: "mmar_list_reviews", resource: "*", effect: "allow" },
    { action: "mmar_get_findings", resource: "*", effect: "allow" },
    { action: "mmar_set_finding_disposition", resource: "*", effect: "allow" },
  ]);
  assert.deepEqual(agents.mmar_correctness.permissions, [
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "mmar_get_findings", resource: "*", effect: "allow" },
    { action: "mmar_begin", resource: "*", effect: "deny" },
    { action: "mmar_complete", resource: "*", effect: "deny" },
    { action: "mmar_list_reviews", resource: "*", effect: "deny" },
    { action: "mmar_set_finding_disposition", resource: "*", effect: "deny" },
  ]);
  assert.deepEqual(agents.mmar_correctness.model, {
    providerID: "test-provider",
    id: "test-model",
    variant: "configured",
  });
  assert.equal(agents.mmar_testing.id, "mmar_testing");
  assert.ok(agents.mmar_testing.system.length > 0);
  cleanup();
});

test("rejects invalid model references during plugin setup with reviewer key context", async () => {
  const { context } = fakeContext({
    options: {
      configPath: "/nonexistent/multireview-plugin.json",
      models: { correctness: "model-without-provider" },
    },
  });

  await assert.rejects(
    () => createMultireviewPlugin(noopLifecycle).setup(context),
    /models\.correctness.*provider\/model/,
  );
});

test("registered execute.before hook enforces MMAR dispatch and edit invariants", async () => {
  const { context, registrations } = fakeContext();
  const cleanup = await createMultireviewPlugin(noopLifecycle).setup(context);
  const hook = registrations.hooks[0].callback;

  assert.throws(() => hook({ tool: "subagent", sessionID: "s", id: "c", agent: "other", input: { agent: "mmar_correctness" } }), /Only mmar_orchestrator/);
  assert.throws(() => hook({ tool: "subagent", sessionID: "s", id: "c", agent: "mmar_orchestrator", input: { agent: "other" } }), /only canonical MMAR specialists/);
  assert.throws(() => hook({ tool: "edit", sessionID: "s", id: "c", agent: "mmar_testing", input: {} }), /may not use edit-class/);
  assert.doesNotThrow(() => hook({ tool: "edit", sessionID: "s", id: "c", agent: "other", input: {} }));
  assert.doesNotThrow(() => hook({ tool: "subagent", sessionID: "s", id: "c", agent: "other", input: { agent: "other" } }));
  cleanup();
});

test("event subscription continues after an event handler fails", async () => {
  let eventCalls = 0;
  const lifecycle = {
    ...noopLifecycle,
    activeReviewForSession() {
      eventCalls += 1;
      if (eventCalls === 1) throw new Error("first event failed");
      return undefined;
    },
  };
  const { context } = fakeContext({ events: [
    { type: "session.execution.failed", data: { sessionID: "first" } },
    { type: "session.execution.failed", data: { sessionID: "second" } },
  ] });
  const cleanup = await createMultireviewPlugin(lifecycle).setup(context);

  for (let attempt = 0; attempt < 20 && eventCalls < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(eventCalls, 2);
  cleanup();
});
