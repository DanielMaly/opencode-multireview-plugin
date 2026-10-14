import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { ReviewStore } from "../dist/storage/reviews.js"
import { createMmarTools } from "../dist/tools.js"
import { ReviewLifecycleHooks } from "../dist/lifecycleHooks.js"
import { PersistentReviewLifecycle } from "../dist/storage/lifecycle.js"
import { laneRegistry } from "../dist/lanes.js"
import { apiHeaders, getJson, isolatedEnvironment, resolveOpenCodeV2, startOpenCodeServer, stopOpenCodeServer, waitForPlugin } from "./opencode-v2-helpers.js"

const resolved = resolveOpenCodeV2()
const agentNames = ["mmar_orchestrator", ...laneRegistry.map(({ specialistAgent }) => specialistAgent)]

function createGitProject(directory) {
  execFileSync("git", ["init", "--quiet", directory])
  execFileSync("git", ["-C", directory, "config", "user.name", "MMAR smoke test"])
  execFileSync("git", ["-C", directory, "config", "user.email", "mmar-smoke@example.invalid"])
  execFileSync("git", ["-C", directory, "commit", "--quiet", "--allow-empty", "-m", "fixture"])
}

function toolContext(directory, agent = "mmar_orchestrator", sessionID = "smoke-session") {
  return { agent, directory, worktree: directory, sessionID }
}

function beginArgs() {
  return {
    target: { kind: "custom", changeset: "deterministic smoke changeset", label: "Smoke review" },
    baseRef: "HEAD",
    requestScope: "deterministic real OpenCode smoke test",
  }
}

function parseToolOutput(value) {
  return JSON.parse(typeof value === "string" ? value : value.content)
}

function location(directory) {
  return `location[directory]=${encodeURIComponent(directory)}`
}

async function responseJson(response, label, serverOutput) {
  const text = await response.text()
  assert.ok(response.ok, `${label} failed: HTTP ${response.status}: ${text}; server=${serverOutput}`)
  return JSON.parse(text)
}

function sendCompletion(response, toolCall, text = "Done.") {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
  const chunk = (choice) => `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "scripted-model", choices: [choice] })}\n\n`
  if (toolCall) {
    response.write(chunk({
      index: 0,
      delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) } }] },
      finish_reason: null,
    }))
    response.write(chunk({ index: 0, delta: {}, finish_reason: "tool_calls" }))
  } else {
    response.write(chunk({ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }))
    response.write(chunk({ index: 0, delta: {}, finish_reason: "stop" }))
  }
  response.end("data: [DONE]\n\n")
}

function toolArguments(tool, project, targetFile) {
  const properties = tool.function.parameters?.properties ?? {}
  const values = {}
  for (const [name, schema] of Object.entries(properties)) {
    const lower = name.toLowerCase()
    if (lower.includes("agent")) values[name] = "mmar_correctness"
    else if (lower.includes("file") || lower === "path") values[name] = targetFile
    else if (lower.includes("prompt")) values[name] = "Run the specialist"
    else if (lower.includes("description")) values[name] = "Hook enforcement test"
    else if (lower.includes("old") || lower.includes("search")) values[name] = "original content"
    else if (lower.includes("new") || lower.includes("content") || lower.includes("patch")) values[name] = "modified by tool"
    else if (schema.type === "string") values[name] = "test"
    else if (schema.type === "boolean") values[name] = false
    else if (schema.type === "number" || schema.type === "integer") values[name] = 1
    else if (schema.type === "array") values[name] = []
    else if (schema.type === "object") values[name] = {}
  }
  return values
}

async function startMockLlm(project, scenario, targetFile) {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    const tools = body.tools ?? []
    requests.push({ tools: tools.map(({ function: fn }) => fn.name), body })
    const lastUserMessage = [...(body.messages ?? [])].reverse().find(({ role }) => role === "user")?.content ?? ""
    const isSummaryRequest = typeof lastUserMessage === "string" && /MUST summarize the conversation/.test(lastUserMessage)
    const target = scenario === "edit"
      ? tools.find(({ function: fn }) => ["edit", "write", "patch"].includes(fn.name))
      : tools.find(({ function: fn }) => fn.name === "subagent")
    const hasToolReply = body.messages?.some(({ role }) => role === "tool")
    if (!hasToolReply && !isSummaryRequest && target) sendCompletion(response, { name: target.function.name, arguments: toolArguments(target, project, targetFile) })
    else if (isSummaryRequest) sendCompletion(response, undefined, "## Objective\n- Exercise the live plugin hook.\n\n## Requirements\n- Use the local scripted model.\n\n## Decisions\n- (none)\n\n## Work State\n### Completed\n- Started the session.\n\n### Active\n- Trigger the test tool call.\n\n### Blocked\n- (none)\n\n## Next Move\n1. Continue the test.\n\n## Relevant Files\n- (none)")
    else sendCompletion(response)
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return { server, port: server.address().port, requests }
}

async function stopMockLlm(server) {
  if (!server?.listening) return
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

async function runHookSession({ project, fixture, agent, scenario, targetFile }) {
  const mock = await startMockLlm(project, scenario, targetFile)
  let server
  try {
    const config = {
      $schema: "https://opencode.ai/config.json",
      plugins: [new URL("..", import.meta.url).pathname.replace(/\/$/, "")],
      model: "mock/scripted",
      providers: {
        mock: {
          name: "Local scripted mock",
          env: ["MOCK_API_KEY"],
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${mock.port}/v1`, transport: "http" },
          models: {
            scripted: {
              modelID: "scripted-model",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 8192, output: 1024 },
            },
          },
        },
      },
      agents: {
        title: { model: "mock/scripted" },
        compaction: { model: "mock/scripted" },
        summary: { model: "mock/scripted" },
        [agent]: {
          model: "mock/scripted",
          mode: "primary",
          permissions: scenario === "edit"
            ? [{ action: "edit", resource: "*", effect: "allow" }]
            : [{ action: "subagent", resource: "*", effect: "allow" }],
        },
      },
    }
    writeFileSync(join(project, "opencode.json"), JSON.stringify(config), "utf8")
    const env = { ...isolatedEnvironment(fixture), MOCK_API_KEY: "dummy" }
    const started = await startOpenCodeServer(resolved.bin, project, env)
    server = started.child
    const hostDirectory = realpathSync(project)
    await waitForPlugin(started.port, `/api/plugin?${location(hostDirectory)}`, ({ source }) => source.type === "local" && source.path.includes("opencode-multireview-plugin"), started.output)
    const sessionResponse = await fetch(`http://127.0.0.1:${started.port}/api/session`, {
      method: "POST",
      headers: { ...apiHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ location: { directory: hostDirectory }, agent }),
    })
    const sessionData = await responseJson(sessionResponse, "session create", started.output.join(""))
    const session = sessionData.data ?? sessionData
    const promptResponse = await fetch(`http://127.0.0.1:${started.port}/api/session/${session.id}/prompt`, {
      method: "POST",
      headers: { ...apiHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ text: "Perform the requested test action now." }),
    })
    const promptText = await promptResponse.text()
    assert.ok(promptResponse.ok, `prompt failed: HTTP ${promptResponse.status}: ${promptText}; server=${started.output.join("")}`)
    const waitResponse = await fetch(`http://127.0.0.1:${started.port}/api/experimental/session/${session.id}/wait`, { method: "POST", headers: apiHeaders() })
    const waitText = await waitResponse.text()
    assert.ok(waitResponse.ok, `session wait failed: HTTP ${waitResponse.status}: ${waitText}; server=${started.output.join("")}`)
    const messageResponse = await fetch(`http://127.0.0.1:${started.port}/api/session/${session.id}/message`, { headers: apiHeaders() })
    const messageData = await responseJson(messageResponse, "message fetch", started.output.join(""))
    const messages = messageData.data ?? messageData
    const toolParts = messages.flatMap((message) => message.type === "assistant" || message.role === "assistant"
      ? (message.content ?? []).filter(({ type }) => type === "tool")
      : [])
    console.log(`MMAR hook session ${agent} tool names:`, JSON.stringify([...new Set(mock.requests.flatMap(({ tools }) => tools))]))
    return { toolParts, messages, requests: mock.requests, serverOutput: started.output.join("") }
  } finally {
    await stopOpenCodeServer(server)
    await stopMockLlm(mock.server)
  }
}

test("real OpenCode V2 loads the local plugin and enforces MMAR lifecycle", { skip: resolved.reason }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), "opencode-multireview-real-smoke-"))
  const project = join(fixture, "project")
  mkdirSync(project, { recursive: true })
  createGitProject(project)
  writeFileSync(join(project, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [new URL("..", import.meta.url).pathname.replace(/\/$/, "")],
    agents: {
      mmar_correctness: {
        permissions: [{ action: "edit", resource: "*", effect: "allow" }],
      },
    },
  }), "utf8")
  const env = isolatedEnvironment(fixture)
  let server
  try {
    const started = await startOpenCodeServer(resolved.bin, project, env)
    server = started.child
    const hostDirectory = realpathSync(project)

    const configs = await getJson(started.port, `/api/config?${location(hostDirectory)}`)
    const projectConfig = configs.find(({ type, path }) => type === "document" && path.endsWith("opencode.json"))
    assert.ok(projectConfig)
    assert.ok(projectConfig.info.plugins.includes(new URL("..", import.meta.url).pathname.replace(/\/$/, "")))
    const localPlugin = await waitForPlugin(started.port, `/api/plugin?${location(hostDirectory)}`, ({ source }) => source.type === "local" && source.path.includes("opencode-multireview-plugin"), started.output)
    const serverAgents = await getJson(started.port, `/api/agent?${location(hostDirectory)}`)
    assert.deepEqual(localPlugin.state, { status: "active" }, JSON.stringify(localPlugin))
    console.log("MMAR real-host plugin status:", JSON.stringify(localPlugin))

    const agents = serverAgents
    const bundledAgents = agents.filter(({ id }) => id.startsWith("mmar_"))
    assert.deepEqual(bundledAgents.map(({ id }) => id).sort(), [...agentNames].sort())
    const orchestrator = agents.find(({ id }) => id === "mmar_orchestrator")
    assert.ok(orchestrator)
    assert.equal(orchestrator.mode, "all")
    assert.equal(orchestrator.hidden, false)
    assert.ok(typeof orchestrator.system === "string" && orchestrator.system.trim())
    const specialists = laneRegistry.map(({ specialistAgent }) => agents.find(({ id }) => id === specialistAgent))
    for (const specialist of specialists) {
      assert.ok(specialist, "missing MMAR specialist")
      assert.equal(specialist.hidden, true)
      assert.equal(specialist.mode, "subagent")
      assert.ok(typeof specialist.system === "string" && specialist.system.trim())
      assert.ok(specialist.permissions.some(({ action, resource, effect }) => action === "edit" && resource === "*" && effect === "deny"))
    }

    const dispatchRules = orchestrator.permissions.filter(({ action }) => action === "subagent")
    assert.deepEqual(dispatchRules.slice(-laneRegistry.length - 1), [
      { action: "subagent", resource: "*", effect: "deny" },
      ...laneRegistry.map(({ specialistAgent }) => ({ action: "subagent", resource: specialistAgent, effect: "allow" })),
    ])
    const correctness = agents.find(({ id }) => id === "mmar_correctness")
    const userEditRule = correctness.permissions.findLast(({ action, resource, effect }) => action === "edit" && resource === "*" && effect === "allow")
    assert.ok(userEditRule, "user-configured edit allow should be appended after plugin permissions")
    console.log("MMAR real-host orchestrator subagent permissions:", JSON.stringify(dispatchRules))
    console.log("MMAR real-host correctness edit permissions:", JSON.stringify(correctness.permissions.filter(({ action }) => action === "edit")))
    // The last-match permission list intentionally demonstrates user config precedence;
    // execute.before, not these declarative permissions, enforces MMAR edit restrictions.

    let skillRegistered = false
    const skillResponse = await fetch(`http://127.0.0.1:${started.port}/api/skill?${location(hostDirectory)}`, { headers: apiHeaders() })
    if (skillResponse.ok) {
      const responseBody = await skillResponse.json()
      const skills = Array.isArray(responseBody) ? responseBody : responseBody.data ?? responseBody
      skillRegistered = skills.some(({ id, name }) => id === "mmar" || name?.toLowerCase() === "mmar")
      assert.ok(skillRegistered, `MMAR skill missing from API: ${JSON.stringify(skills)}`)
      assert.equal(existsSync(join(project, ".opencode", "skills", "mmar", "SKILL.md")), false)
    } else {
      console.log(`MMAR skill API unavailable (HTTP ${skillResponse.status}); plugin setup and skill transform ran without error`)
    }

    // These are the same exported tools/hooks registered by the real plugin,
    // backed by isolated SQLite state; no model request is made.
    const databasePath = join(fixture, "plugin-state", "reviews.sqlite")
    const tools = createMmarTools({ databasePath })
    assert.equal(typeof tools.mmar_set_finding_disposition, "object")
    const hooks = new ReviewLifecycleHooks(new PersistentReviewLifecycle({ databasePath }), () => {})
    const sessionID = "smoke-session"
    const dispatch = { tool: "subagent", sessionID, callID: "smoke-call" }
    assert.throws(() => hooks.beforeTool(dispatch, { agent: "mmar_correctness" }, "mmar_orchestrator"), /active review lock/)

    const begun = parseToolOutput(await tools.mmar_begin.execute(beginArgs(), toolContext(project, "mmar_orchestrator", sessionID)))
    assert.equal(begun.locked, false)
    assert.doesNotThrow(() => hooks.beforeTool(dispatch, { agent: "mmar_correctness" }, "mmar_orchestrator"))
    assert.throws(() => hooks.beforeTool({ ...dispatch, tool: "edit" }, {}, "mmar_correctness"), /may not use edit-class tools/)
    assert.throws(() => hooks.beforeTool(dispatch, { agent: "mmar_correctness" }, "mmar_testing"), /Only mmar_orchestrator/)
    assert.throws(() => hooks.beforeTool(dispatch, { agent: "general" }, "mmar_orchestrator"), /may dispatch only canonical/)

    const completed = parseToolOutput(await tools.mmar_complete.execute({
      reviewId: begun.reviewId,
      roundId: begun.roundId,
      fencingToken: begun.fencingToken,
      laneResults: ["correctness", "codestyle", "testing"].map((lane) => ({ lane, status: "completed" })),
      validFindings: [{
        disposition: "valid",
        severity: "LOW",
        category: "TESTING",
        title: "Smoke finding",
        bodyMarkdown: "Deterministic smoke evidence",
        sourceAgents: ["mmar_testing"],
      }],
    }, toolContext(project, "mmar_orchestrator", sessionID)))
    assert.deepEqual(completed, { roundId: begun.roundId, idempotent: false })
    const store = new ReviewStore({ databasePath })
    assert.deepEqual(store.listRounds(begun.reviewId).map(({ id }) => id), [begun.roundId])
    assert.equal(store.inspectLock(begun.reviewId), undefined)
    const smokeFinding = store.getRound(begun.reviewId).validFindings[0]
    const disposition = parseToolOutput(await tools.mmar_set_finding_disposition.execute({ findingId: smokeFinding.id, disposition: "ignored", reason: "Smoke disposition" }, toolContext(project, "mmar_orchestrator", "disposition-session")))
    assert.equal(disposition.disposition, "ignored")
    assert.equal(store.getRound(begun.reviewId).ignoredFindings[0].wontfix, "Smoke disposition")
    assert.throws(() => hooks.beforeTool(dispatch, { agent: "mmar_correctness" }, "mmar_orchestrator"), /active review lock/)
    assert.equal(existsSync(join(project, "REVIEW_FINDINGS.md")), false)
    if (skillRegistered) console.log("MMAR real-host skill: registered via /api/skill")
  } finally {
    await stopOpenCodeServer(server)
    rmSync(fixture, { recursive: true, force: true })
  }
})

test("real OpenCode V2 hook rejects edit escalation through a live session", { skip: resolved.reason }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), "opencode-multireview-hook-edit-"))
  const project = join(fixture, "project")
  mkdirSync(project, { recursive: true })
  createGitProject(project)
  const targetFile = join(project, "protected.txt")
  writeFileSync(targetFile, "original content", "utf8")
  try {
    const result = await runHookSession({ project, fixture, agent: "mmar_orchestrator", scenario: "edit", targetFile })
    const editTool = result.toolParts.find(({ name }) => ["edit", "write", "patch"].includes(name))
    assert.ok(editTool, `no edit-class tool call: tools=${JSON.stringify(result.requests.map(({ tools }) => tools))}; output=${result.serverOutput}`)
    assert.equal(editTool.state.status, "error")
    assert.match(editTool.state.error.message, /Bundled MMAR agents may not use edit-class tools/)
    assert.equal(readFileSync(targetFile, "utf8"), "original content")
    console.log("MMAR edit hook error:", editTool.state.error.message)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test("real OpenCode V2 hook rejects specialist dispatch from a non-orchestrator", { skip: resolved.reason }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), "opencode-multireview-hook-subagent-"))
  const project = join(fixture, "project")
  mkdirSync(project, { recursive: true })
  createGitProject(project)
  try {
    const result = await runHookSession({ project, fixture, agent: "caller", scenario: "subagent", targetFile: project })
    const dispatch = result.toolParts.find(({ name }) => name === "subagent")
    assert.ok(dispatch, `no subagent tool call: tools=${JSON.stringify(result.requests.map(({ tools }) => tools))}; output=${result.serverOutput}`)
    assert.equal(dispatch.state.status, "error")
    assert.match(dispatch.state.error.message, /Only mmar_orchestrator may dispatch canonical MMAR specialists/)
    console.log("MMAR subagent hook error:", dispatch.state.error.message)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
