import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:net"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { contentSha256, installSkill, provenancePathFor } from "../dist/installer.js"
import { globalAgentPath, globalSkillPath, projectAgentPath, projectSkillPath, skillPath } from "../dist/paths.js"

const cli = new URL("../dist/cli.js", import.meta.url)

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "opencode-multireview-installer-"))
}

test("installs missing skills, updates unchanged owned copies, and preserves modifications", () => {
  const directory = temporaryDirectory()
  const previousXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = join(directory, "xdg-config")
  try {
    const destination = globalSkillPath()
    const first = installSkill("global", directory)
    assert.equal(first.status, "installed")
    assert.equal(readFileSync(destination, "utf8"), readFileSync(skillPath, "utf8"))
    const agent = globalAgentPath("mmar_testing")
    assert.match(readFileSync(agent, "utf8"), /description: MMAR agent managed by opencode-multireview-plugin/)
    assert.equal(JSON.parse(readFileSync(provenancePathFor(agent), "utf8")).contentSha256, contentSha256(readFileSync(agent, "utf8")))
    const provenance = JSON.parse(readFileSync(provenancePathFor(destination), "utf8"))
    assert.equal(provenance.contentSha256, contentSha256(readFileSync(destination, "utf8")))

    const olderContent = "older owned skill\n"
    writeFileSync(destination, olderContent)
    writeFileSync(provenancePathFor(destination), JSON.stringify({ packageName: "opencode-multireview-plugin", packageVersion: "0.3.0", contentSha256: contentSha256(olderContent) }))
    const updated = installSkill("global", directory)
    assert.equal(updated.status, "updated")

    writeFileSync(destination, readFileSync(skillPath, "utf8"))
    const unchanged = installSkill("global", directory)
    assert.equal(unchanged.status, "unchanged")

    writeFileSync(destination, "user modification\n")
    writeFileSync(agent, "user agent modification\n")
    const preserved = installSkill("global", directory)
    assert.equal(preserved.status, "preserved")
    assert.equal(readFileSync(destination, "utf8"), "user modification\n")
    assert.equal(readFileSync(agent, "utf8"), "user agent modification\n")
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
    rmSync(directory, { recursive: true, force: true })
  }
})

test("uses literal OpenCode project and XDG global paths", () => {
  const directory = temporaryDirectory()
  const previousXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = join(directory, "xdg")
  try {
    const project = installSkill("project", directory)
    assert.equal(project.skillPath, projectSkillPath(realpathSync(directory)))
    assert.ok(existsSync(join(directory, ".opencode", "skills", "mmar", "SKILL.md")))
    const projectRoot = realpathSync(directory)
    assert.equal(projectAgentPath(projectRoot, "mmar_intent"), join(projectRoot, ".opencode", "agents", "mmar_intent.md"))
    assert.ok(existsSync(projectAgentPath(projectRoot, "mmar_intent")))
    assert.equal(globalSkillPath(), join(directory, "xdg", "opencode", "skills", "mmar", "SKILL.md"))
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
    rmSync(directory, { recursive: true, force: true })
  }
})

test("requires exactly one install mode and rejects both modes", () => {
  const missing = spawnSync(process.execPath, [cli.pathname, "skill", "install"], { encoding: "utf8" })
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /exactly one of --global or --project is required/)
  const both = spawnSync(process.execPath, [cli.pathname, "skill", "install", "--global", "--project"], { encoding: "utf8" })
  assert.notEqual(both.status, 0)
  assert.match(both.stderr, /cannot be used with option '--project'/)
})

test("CLI subprocess installs global and project skills", () => {
  const directory = temporaryDirectory()
  const xdg = join(directory, "xdg")
  const environment = { ...process.env, HOME: directory, XDG_CONFIG_HOME: xdg }
  try {
    const global = spawnSync(process.execPath, [cli.pathname, "skill", "install", "--global"], { cwd: directory, env: environment, encoding: "utf8" })
    assert.equal(global.status, 0, `${global.stdout}\n${global.stderr}`)
    assert.match(global.stdout, /Installed MMAR skill at/)
    assert.ok(existsSync(join(xdg, "opencode", "skills", "mmar", "SKILL.md")))
    assert.ok(existsSync(join(xdg, "opencode", "agents", "mmar_orchestrator.md")))

    const project = spawnSync(process.execPath, [cli.pathname, "skill", "install", "--project"], { cwd: directory, env: environment, encoding: "utf8" })
    assert.equal(project.status, 0, `${project.stdout}\n${project.stderr}`)
    assert.match(project.stdout, /Installed MMAR skill at/)
    assert.ok(existsSync(join(directory, ".opencode", "skills", "mmar", "SKILL.md")))
    assert.ok(existsSync(join(directory, ".opencode", "agents", "mmar_orchestrator.md")))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("CLI entry point runs from a path containing URL-encoded characters", () => {
  const directory = temporaryDirectory()
  const spaced = join(directory, "path with spaces")
  const dist = join(spaced, "dist")
  mkdirSync(dist, { recursive: true })
  cpSync(new URL("../dist", import.meta.url), dist, { recursive: true })
  cpSync(new URL("../assets", import.meta.url), join(spaced, "assets"), { recursive: true })
  cpSync(new URL("../package.json", import.meta.url), join(spaced, "package.json"))
  cpSync(new URL("../node_modules/commander", import.meta.url), join(spaced, "node_modules", "commander"), { recursive: true })
  try {
    const result = spawnSync(process.execPath, [join(dist, "cli.js"), "skill", "install", "--project"], { cwd: spaced, encoding: "utf8" })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.ok(existsSync(join(spaced, ".opencode", "skills", "mmar", "SKILL.md")), `${result.stdout}\n${result.stderr}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("provenance is committed before content so a content-write failure cannot create new content with stale ownership", () => {
  const directory = temporaryDirectory()
  const previousXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = join(directory, "xdg")
  try {
    const destination = globalSkillPath()
    installSkill("global", directory)
    const olderContent = "older owned skill\n"
    writeFileSync(destination, olderContent)
    writeFileSync(provenancePathFor(destination), JSON.stringify({ packageName: "opencode-multireview-plugin", packageVersion: "0.3.0", contentSha256: contentSha256(olderContent) }))

    assert.throws(() => installSkill("global", directory, (path, content) => {
      if (path === destination) throw new Error("simulated content write failure")
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }), /simulated content write failure/)
    assert.equal(readFileSync(destination, "utf8"), olderContent)
    assert.equal(JSON.parse(readFileSync(provenancePathFor(destination), "utf8")).contentSha256, contentSha256(readFileSync(skillPath, "utf8")))
    assert.equal(installSkill("global", directory).status, "preserved")
    assert.equal(readFileSync(destination, "utf8"), olderContent)
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
    rmSync(directory, { recursive: true, force: true })
  }
})

test("corrupt or incomplete provenance preserves modified and unowned skills", () => {
  const directory = temporaryDirectory()
  const previousXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = join(directory, "xdg")
  try {
    const destination = globalSkillPath()
    installSkill("global", directory)
    writeFileSync(destination, "user-edited content\n")

    writeFileSync(provenancePathFor(destination), "{broken json")
    assert.equal(installSkill("global", directory).status, "preserved")
    assert.equal(readFileSync(destination, "utf8"), "user-edited content\n")

    writeFileSync(provenancePathFor(destination), JSON.stringify({ packageName: "opencode-multireview-plugin" }))
    assert.equal(installSkill("global", directory).status, "preserved")
    assert.equal(readFileSync(destination, "utf8"), "user-edited content\n")

    unlinkSync(provenancePathFor(destination))
    assert.equal(installSkill("global", directory).status, "preserved")
    assert.equal(readFileSync(destination, "utf8"), "user-edited content\n")
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
    rmSync(directory, { recursive: true, force: true })
  }
})

test("packed artifact contains the installed skill and installer inputs", () => {
  const result = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" })
  const files = JSON.parse(result).at(-1).files.map((file) => file.path)
  assert.ok(files.includes("assets/skills/mmar/SKILL.md"))
  assert.ok(files.includes("dist/installer.js"))
})

test("packed artifact declares its runtime plugin dependency", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(packageJson.dependencies["@opencode/plugin"], "^2.0.26")
  assert.equal(packageJson.devDependencies["@opencode/plugin"], undefined)
})

async function reservePort() {
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

test("OpenCode discovers the installed MMAR skill and plugin agents in isolation", { skip: !commandExists("opencode") ? "opencode binary is unavailable" : false }, async () => {
  const directory = temporaryDirectory()
  const installDirectory = join(directory, "install")
  const xdgConfigHome = join(directory, "xdg")
  let server
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: directory })
    execFileSync("git", ["-c", "user.name=MMAR test", "-c", "user.email=mmar-test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"], { cwd: directory })
    installSkill("project", directory)
    mkdirSync(installDirectory)
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", directory], { encoding: "utf8" }))[0]
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(directory, packed.filename)], {
      cwd: installDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    // OpenCode 2.0.25 requires the matching V2 plugin/schema runtime rather
    // than the newest compatible semver release pulled by npm.
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", "@opencode/plugin@2.0.26", "@opencode/schema@2.0.26"], {
      cwd: installDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const pluginPath = join(installDirectory, "node_modules", "opencode-multireview-plugin", "dist")
    writeFileSync(join(directory, "opencode.json"), JSON.stringify({
      "$schema": "https://opencode.ai/config.json",
      "plugins": [`${pathToFileURL(pluginPath).href}/`],
    }))
    const env = {
      ...process.env,
      HOME: join(directory, "home"),
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: join(directory, "data"),
      XDG_STATE_HOME: join(directory, "state"),
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    }
    delete env.OPENCODE_CONFIG
    delete env.OPENCODE_CONFIG_CONTENT
    for (const path of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME]) mkdirSync(path, { recursive: true })
    const port = await reservePort()
    server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] })
    const password = await waitForServer(server, port)
    const skillResponse = await waitForJson(port, "/api/skill", password, ({ data }) => data.some(({ id }) => id === "mmar"))
    const mmarSkill = skillResponse.data.find(({ id }) => id === "mmar")
    assert.ok(mmarSkill, "V2 skill discovery did not find mmar")

    const agents = (await waitForJson(port, "/api/agent", password, ({ data }) => data.some(({ name }) => name === "mmar_orchestrator"))).data
    const byName = new Map(agents.map((agent) => [agent.name, agent]))
    const specialists = ["mmar_correctness", "mmar_codestyle", "mmar_testing", "mmar_intent"]
    for (const name of ["mmar_orchestrator", ...specialists]) assert.ok(byName.get(name)?.system?.trim(), `missing populated ${name}`)
    const permissions = byName.get("mmar_orchestrator").permissions.filter(({ action }) => action === "subagent")
    assert.deepEqual(permissions, [
      { action: "subagent", resource: "*", effect: "deny" },
      ...specialists.map((resource) => ({ action: "subagent", resource, effect: "allow" })),
    ])
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM")
      await new Promise((resolve) => server.once("exit", resolve))
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

function commandExists(command) {
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0
}
