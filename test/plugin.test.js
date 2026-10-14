import test from "node:test";
import assert from "node:assert/strict";
import { createMultireviewPlugin, MultireviewPlugin } from "../dist/index.js";
import { mmarTools } from "../dist/tools.js";

function fakeContext() {
  const registrations = { tools: [], agents: [], skills: [], hooks: [] };
  let stopEvents;
  const context = {
    options: { configPath: "/nonexistent/multireview-plugin.json" },
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
        const agents = Object.fromEntries(["mmar_orchestrator", "mmar_codestyle", "mmar_correctness", "mmar_testing", "mmar_intent"].map((id) => [id, { id }]));
        callback({ get: (id) => agents[id], update: (id, fn) => { if (agents[id]) fn(agents[id]); } });
        registrations.agents.push(agents);
        return { dispose: async () => {} };
      },
      reload: async () => {},
    },
    skill: {
      transform: async (callback) => {
        callback({ get: () => undefined, add: (skill) => registrations.skills.push(skill) });
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: ({ signal }) => {
        stopEvents = () => {};
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ done: true }), { once: true })),
            };
          },
        };
      },
    },
  };
  return { context, registrations, stopEvents: () => stopEvents?.() };
}

test("exports a V2 definition with a stable id and setup function", () => {
  assert.equal(MultireviewPlugin.id, "opencode-multireview-plugin");
  assert.equal(typeof MultireviewPlugin.setup, "function");
  assert.equal(Object.hasOwn(MultireviewPlugin, "server"), false);
});

test("setup registers V2 tools, skill, and lifecycle hooks", async () => {
  const { context, registrations } = fakeContext();
  const cleanup = await createMultireviewPlugin({
    activeReviewForSession: () => undefined,
    recordIncompleteDiagnosticMarker: () => ({ deduplicated: true }),
    releaseIncompleteDiagnosticMarker: () => {},
  }).setup(context);

  assert.deepEqual(registrations.tools.map(({ name }) => name).sort(), [
    "mmar_begin", "mmar_complete", "mmar_get_findings", "mmar_list_reviews", "mmar_set_finding_disposition",
  ]);
  assert.equal(registrations.skills[0].id, "mmar");
  assert.deepEqual(registrations.hooks.map(({ name }) => name), ["execute.before"]);
  // The host discovers the installer-created stubs before update() fills them.
  const agents = registrations.agents[0];
  assert.deepEqual(Object.keys(agents).sort(), ["mmar_codestyle", "mmar_correctness", "mmar_intent", "mmar_orchestrator", "mmar_testing"]);
  assert.equal(agents.mmar_testing.id, "mmar_testing");
  assert.ok(agents.mmar_testing.system.length > 0);
  const tasks = agents.mmar_orchestrator.permissions.filter(({ action }) => action === "subagent");
  assert.deepEqual(tasks[0], { action: "subagent", resource: "*", effect: "deny" });
  assert.ok(tasks.some(({ resource, effect }) => resource === "mmar_testing" && effect === "allow"));
  assert.deepEqual(agents.mmar_testing.permissions.find(({ action }) => action === "mmar_begin"), { action: "mmar_begin", resource: "*", effect: "deny" });
  assert.deepEqual(agents.mmar_testing.permissions.find(({ action }) => action === "mmar_get_findings"), { action: "mmar_get_findings", resource: "*", effect: "allow" });
  assert.deepEqual(agents.mmar_orchestrator.permissions.find(({ action }) => action === "mmar_begin"), { action: "mmar_begin", resource: "*", effect: "allow" });
  cleanup();
});

test("V2 tool definitions expose Effect schemas and structured content", () => {
  for (const definition of Object.values(mmarTools)) {
    assert.equal(typeof definition.input.fields, "object");
    assert.equal(typeof definition.execute, "function");
  }
});

const noLifecycle = { activeReviewForSession: () => undefined, recordIncompleteDiagnosticMarker: () => ({ deduplicated: true }), releaseIncompleteDiagnosticMarker: () => {} };

test("setup maps configured models and variants to V2 model references", async () => {
  const { context, registrations } = fakeContext();
  context.options = { ...context.options, models: { testing: { model: "openai/gpt-5/mini", variant: "high" }, codestyle: "anthropic/claude" } };
  const cleanup = await createMultireviewPlugin(noLifecycle).setup(context);
  const agents = registrations.agents[0];
  assert.deepEqual(agents.mmar_testing.model, { providerID: "openai", id: "gpt-5/mini", variant: "high" });
  assert.deepEqual(agents.mmar_codestyle.model, { providerID: "anthropic", id: "claude" });
  cleanup();
});

test("setup rejects a model reference without a provider", async () => {
  const { context } = fakeContext();
  context.options = { ...context.options, models: { testing: "no-provider" } };
  await assert.rejects(() => createMultireviewPlugin(noLifecycle).setup(context), /expected "provider\/model"/);
});
