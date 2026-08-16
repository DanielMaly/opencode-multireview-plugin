import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { ReviewStore } from "../dist/storage/reviews.js"
import { createMmarTools } from "../dist/tools.js"
import { ReviewLifecycleHooks } from "../dist/lifecycleHooks.js"
import { PersistentReviewLifecycle } from "../dist/storage/lifecycle.js"

const pluginEntry = new URL("../dist/index.js", import.meta.url)
const bundledSkills = new URL("../assets/skills", import.meta.url)
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
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
  }

  for (const name of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_SERVER", "OPENCODE_PID"]) delete environment[name]
  return environment
}

function runOpenCode(args, cwd, env) {
  const result = spawnSync("opencode", args, { cwd, env, encoding: "utf8" })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return result.stdout
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

async function waitForServer(process, port) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`OpenCode server exited before becoming ready (exit ${process.exitCode})`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/config`)
      if (response.ok) return
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("OpenCode server did not become ready")
}

async function getJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`)
  assert.equal(response.ok, true, `${path} returned HTTP ${response.status}`)
  return response.json()
}

function writeLegacyAgents(project) {
  const directory = join(project, ".opencode", "agents")
  mkdirSync(directory, { recursive: true })
  for (const name of ["multireview", "_correctness", "_codestyle", "_testing"]) {
    writeFileSync(join(directory, `${name}.md`), `---\ndescription: Legacy ${name} fixture\nmode: subagent\n---\nLegacy fixture agent.\n`, "utf8")
  }
}

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
  return JSON.parse(value)
}

test("real OpenCode loads the local plugin alongside legacy agents and enforces MMAR lifecycle", { skip: !commandExists("opencode") ? "opencode binary is unavailable" : false }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), "opencode-multireview-real-smoke-"))
  const project = join(fixture, "project")
  mkdirSync(project, { recursive: true })
  createGitProject(project)
  writeLegacyAgents(project)

  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: [pluginEntry.href],
    // OpenCode 1.18.x resolves plugin config hooks only in the running server.
    // Supplying the same bundled path here lets its native debug skill command
    // prove discovery without installing a global or project copy.
    skills: { paths: [new URL(bundledSkills).pathname] },
    // A provider catalogue is required by OpenCode's debug agent command, but
    // no credentials or model request are used by this smoke test.
    enabled_providers: ["github-copilot"],
    disabled_providers: ["github-copilot", "llm-gateway"],
    mcp: {},
  }
  writeFileSync(join(project, "opencode.json"), JSON.stringify(config), "utf8")
  const env = isolatedEnvironment(fixture)
  mkdirSync(env.HOME, { recursive: true })
  mkdirSync(env.XDG_CONFIG_HOME, { recursive: true })
  mkdirSync(env.XDG_DATA_HOME, { recursive: true })
  mkdirSync(env.XDG_STATE_HOME, { recursive: true })

  let server
  try {
    const resolvedConfig = JSON.parse(runOpenCode(["debug", "config"], project, env))
    assert.deepEqual(resolvedConfig.plugin, [pluginEntry.href])
    assert.deepEqual(resolvedConfig.plugin_origins.map(({ scope, spec }) => ({ scope, spec })), [{ scope: "local", spec: pluginEntry.href }])
    assert.equal(resolvedConfig.mcp && Object.keys(resolvedConfig.mcp).length, 0)

    const skills = JSON.parse(runOpenCode(["debug", "skill"], project, env))
    const mmarSkill = skills.find(({ name }) => name === "mmar")
    assert.ok(mmarSkill, "native debug skill discovery did not find mmar")
    assert.equal(mmarSkill.location, new URL(bundledSkillFile).pathname)
    assert.equal(existsSync(join(project, ".opencode", "skills", "mmar", "SKILL.md")), false)

    for (const name of ["mmar_orchestrator", "mmar_correctness", "mmar_codestyle", "mmar_testing", "mmar_intent"]) {
      const agent = JSON.parse(runOpenCode(["debug", "agent", name], project, env))
      assert.equal(agent.name, name)
      assert.match(agent.prompt, /MMAR|internal MMAR lane/)
    }

    const port = await reservePort()
    server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: project,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    await waitForServer(server, port)

    const serverConfig = await getJson(port, "/config")
    const serverSkillPath = serverConfig.skills.paths.find((path) => path.includes("opencode-multireview-plugin"))
    assert.equal(serverSkillPath, new URL(bundledSkills).pathname)
    assert.equal(existsSync(join(serverSkillPath, "mmar", "SKILL.md")), true)

    const agents = await getJson(port, "/agent")
    const agentNames = agents.map(({ name }) => name)
    assert.deepEqual(agentNames.filter((name) => name.startsWith("mmar_")).sort(), [
      "mmar_codestyle",
      "mmar_correctness",
      "mmar_intent",
      "mmar_orchestrator",
      "mmar_testing",
    ])
    for (const legacy of ["multireview", "_correctness", "_codestyle", "_testing"]) assert.ok(agentNames.includes(legacy), `missing legacy agent ${legacy}`)

    // Lifecycle evidence boundary: no model is involved. These are the same
    // exported tools/hooks registered by the real plugin, backed by isolated
    // SQLite state in this temporary fixture.
    const databasePath = join(fixture, "plugin-state", "reviews.sqlite")
    const tools = createMmarTools({ databasePath })
    const hooks = new ReviewLifecycleHooks(new PersistentReviewLifecycle({ databasePath }), () => {})
    const sessionID = "smoke-session"
    const task = { tool: "task", sessionID, callID: "smoke-call" }
    assert.throws(() => hooks.beforeTool(task, { subagent_type: "mmar_correctness" }), /active review lock/)

    const begun = parseToolOutput(await tools.mmar_begin.execute(beginArgs(), toolContext(project, "mmar_orchestrator", sessionID)))
    assert.equal(begun.locked, false)
    assert.doesNotThrow(() => hooks.beforeTool(task, { subagent_type: "mmar_correctness" }))

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
    assert.throws(() => hooks.beforeTool(task, { subagent_type: "mmar_correctness" }), /active review lock/)
    assert.equal(existsSync(join(project, "REVIEW_FINDINGS.md")), false)
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM")
      await new Promise((resolve) => server.once("exit", resolve))
    }
    rmSync(fixture, { recursive: true, force: true })
  }
})
