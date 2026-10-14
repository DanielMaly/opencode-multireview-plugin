import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:net"
import test from "node:test"
import { installSkill } from "../dist/installer.js"
import { createMmarTools } from "../dist/tools.js"
import { ReviewStore } from "../dist/storage/reviews.js"
import { ReviewLifecycleHooks } from "../dist/lifecycleHooks.js"
import { PersistentReviewLifecycle } from "../dist/storage/lifecycle.js"
import { laneRegistry } from "../dist/lanes.js"

const pluginEntry = new URL("../dist/", import.meta.url)
const bundledSkillFile = new URL("../assets/skills/mmar/SKILL.md", import.meta.url)

function commandExists(command) {
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0
}

function isolatedEnvironment(directory) {
  const environment = {
    ...process.env,
    HOME: join(directory, "home"),
    XDG_CONFIG_HOME: join(directory, "xdg-config"),
    XDG_DATA_HOME: join(directory, "xdg-data"),
    XDG_STATE_HOME: join(directory, "xdg-state"),
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
  }
  for (const name of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_SERVER", "OPENCODE_PID"]) delete environment[name]
  return environment
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

function authorization(password) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}

async function waitForServer(process, port) {
  let output = ""
  process.stdout.setEncoding("utf8")
  process.stdout.on("data", (chunk) => { output += chunk })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`OpenCode server exited before becoming ready (exit ${process.exitCode})`)
    const password = output.match(/server password (\S+)/)?.[1]
    if (password) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/agent`, { headers: { authorization: authorization(password) } })
        if (response.ok) return password
      } catch {
        // The server is still starting.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`OpenCode server did not become ready: ${output}`)
}

async function getJson(port, path, password) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: authorization(password) } })
  assert.equal(response.ok, true, `${path} returned HTTP ${response.status}`)
  return response.json()
}

async function waitForJson(port, path, password, predicate) {
  const deadline = Date.now() + 20_000
  let value
  while (Date.now() < deadline) {
    value = await getJson(port, path, password)
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${path}: ${JSON.stringify(value)}`)
}

function createGitProject(directory) {
  execFileSync("git", ["init", "--quiet", directory])
  execFileSync("git", ["-C", directory, "config", "user.name", "MMAR smoke test"])
  execFileSync("git", ["-C", directory, "config", "user.email", "mmar-smoke@example.invalid"])
  execFileSync("git", ["-C", directory, "commit", "--quiet", "--allow-empty", "-m", "fixture"])
}

function assertMmarAgents(agents) {
  const byName = new Map(agents.map((agent) => [agent.name, agent]))
  const specialists = laneRegistry.map((lane) => lane.specialistAgent)
  const names = ["mmar_orchestrator", ...specialists]
  for (const name of names) {
    const agent = byName.get(name)
    assert.ok(agent, `missing ${name}`)
    assert.ok(agent.system?.trim(), `${name} has no plugin system prompt`)
  }
  assert.equal(byName.get("mmar_orchestrator").hidden, false)
  for (const name of specialists) assert.equal(byName.get(name).hidden, true)

  const subagentPermissions = byName.get("mmar_orchestrator").permissions.filter(({ action }) => action === "subagent")
  assert.deepEqual(subagentPermissions, [
    { action: "subagent", resource: "*", effect: "deny" },
    ...specialists.map((resource) => ({ action: "subagent", resource, effect: "allow" })),
  ])
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

test("real OpenCode loads the local plugin and enforces MMAR lifecycle", { skip: !commandExists("opencode") ? "opencode binary is unavailable" : false }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), "opencode-multireview-real-smoke-"))
  const project = join(fixture, "project")
  mkdirSync(project, { recursive: true })
  createGitProject(project)
  installSkill("project", project)
  rmSync(join(project, ".opencode", "skills"), { recursive: true, force: true })
  writeFileSync(join(project, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [pluginEntry.href],
    experimental: { subagent_depth: 2 },
  }), "utf8")
  const env = isolatedEnvironment(fixture)
  for (const path of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME]) mkdirSync(path, { recursive: true })

  let server
  try {
    const port = await reservePort()
    server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
    const password = await waitForServer(server, port)
    const agentResponse = await waitForJson(port, "/api/agent", password, ({ data }) => data.some(({ name }) => name === "mmar_orchestrator"))
    assertMmarAgents(agentResponse.data)

    const skillResponse = await waitForJson(port, "/api/skill", password, ({ data }) => data.some(({ id }) => id === "mmar"))
    const mmarSkill = skillResponse.data.find(({ id }) => id === "mmar")
    assert.ok(mmarSkill, "V2 skill discovery did not find mmar")
    assert.equal(mmarSkill.path, bundledSkillFile.pathname)

    // V1 debug commands, legacy agent fixtures, and V1 task permission shapes
    // are intentionally not asserted: V2 exposes the normalized HTTP resources.
    const databasePath = join(fixture, "plugin-state", "reviews.sqlite")
    const tools = createMmarTools({ databasePath })
    const hooks = new ReviewLifecycleHooks(new PersistentReviewLifecycle({ databasePath }), () => {})
    const sessionID = "smoke-session"
    const task = { tool: "subagent", sessionID, callID: "smoke-call" }
    assert.throws(() => hooks.beforeTool(task, { agent: "mmar_correctness" }), /active review lock/)

    const begun = parseToolOutput(await tools.mmar_begin.execute(beginArgs(), toolContext(project, "mmar_orchestrator", sessionID)))
    assert.equal(begun.locked, false)
    assert.doesNotThrow(() => hooks.beforeTool(task, { agent: "mmar_correctness" }))

    const completed = parseToolOutput(await tools.mmar_complete.execute({
      reviewId: begun.reviewId,
      roundId: begun.roundId,
      fencingToken: begun.fencingToken,
      laneResults: ["correctness", "codestyle", "testing"].map((lane) => ({ lane, status: "completed" })),
      validFindings: [{ disposition: "valid", severity: "LOW", category: "TESTING", title: "Smoke finding", bodyMarkdown: "Deterministic smoke evidence", sourceAgents: ["mmar_testing"] }],
    }, toolContext(project, "mmar_orchestrator", sessionID)))
    assert.deepEqual(completed, { roundId: begun.roundId, idempotent: false })
    const store = new ReviewStore({ databasePath })
    assert.deepEqual(store.listRounds(begun.reviewId).map(({ id }) => id), [begun.roundId])
    const smokeFinding = store.getRound(begun.reviewId).validFindings[0]
    const disposition = parseToolOutput(await tools.mmar_set_finding_disposition.execute({ findingId: smokeFinding.id, disposition: "ignored", reason: "Smoke disposition" }, toolContext(project, "mmar_orchestrator", "disposition-session")))
    assert.equal(disposition.disposition, "ignored")
    assert.equal(store.getRound(begun.reviewId).ignoredFindings[0].wontfix, "Smoke disposition")
    assert.throws(() => hooks.beforeTool(task, { agent: "mmar_correctness" }), /active review lock/)
    assert.equal(existsSync(join(project, "REVIEW_FINDINGS.md")), false)
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM")
      await new Promise((resolve) => server.once("exit", resolve))
    }
    rmSync(fixture, { recursive: true, force: true })
  }
})
