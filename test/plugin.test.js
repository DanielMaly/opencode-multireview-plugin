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
  // V2 update() creates agents that do not exist yet, so all bundled agents must be registered.
  const agents = registrations.agents[0];
  assert.deepEqual(Object.keys(agents).sort(), ["mmar_codestyle", "mmar_correctness", "mmar_intent", "mmar_orchestrator", "mmar_testing"]);
  assert.equal(agents.mmar_testing.id, "mmar_testing");
  assert.ok(agents.mmar_testing.system.length > 0);
  const tasks = agents.mmar_orchestrator.permissions.filter(({ action }) => action === "subagent");
  assert.deepEqual(tasks[0], { action: "subagent", resource: "*", effect: "deny" });
  assert.ok(tasks.some(({ resource, effect }) => resource === "mmar_testing" && effect === "allow"));
  cleanup();
});

test("V2 tool definitions expose JSON schemas and structured content", () => {
  for (const definition of Object.values(mmarTools)) {
    assert.equal(definition.input.type, "object");
    assert.equal(typeof definition.execute, "function");
  }
});
