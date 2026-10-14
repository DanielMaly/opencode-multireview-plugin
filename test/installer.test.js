import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { contentSha256, installSkill, provenancePathFor } from "../dist/installer.js"
import { globalSkillPath, projectSkillPath, skillPath } from "../dist/paths.js"
import { apiHeaders, getJson, isolatedEnvironment, resolveOpenCodeV2, startOpenCodeServer, stopOpenCodeServer, waitForPlugin } from "./opencode-v2-helpers.js"

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
    const preserved = installSkill("global", directory)
    assert.equal(preserved.status, "preserved")
    assert.equal(readFileSync(destination, "utf8"), "user modification\n")
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

    const project = spawnSync(process.execPath, [cli.pathname, "skill", "install", "--project"], { cwd: directory, env: environment, encoding: "utf8" })
    assert.equal(project.status, 0, `${project.stdout}\n${project.stderr}`)
    assert.match(project.stdout, /Installed MMAR skill at/)
    assert.ok(existsSync(join(directory, ".opencode", "skills", "mmar", "SKILL.md")))
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

test("packed artifact declares optional OpenCode runtime peer dependencies", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(packageJson.dependencies["@opencode/plugin"], undefined)
  assert.equal(packageJson.dependencies.effect, undefined)
  assert.equal(packageJson.peerDependencies["@opencode/plugin"], "^2.0.26")
  assert.equal(packageJson.peerDependencies.effect, "4.0.0-rc.112")
  assert.deepEqual(packageJson.peerDependenciesMeta, {
    "@opencode/plugin": { optional: true },
    effect: { optional: true },
  })
  assert.equal(packageJson.devDependencies["@opencode/plugin"], "2.0.26")
  assert.equal(packageJson.devDependencies.effect, "4.0.0-rc.112")
})

const openCodeV2 = resolveOpenCodeV2()

test("OpenCode discovers the installed MMAR skill and plugin agents in isolation", { skip: openCodeV2.reason, timeout: 90_000 }, async () => {
  const directory = temporaryDirectory()
  const installDirectory = join(directory, "install")
  let server
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: directory })
    execFileSync("git", ["-c", "user.name=MMAR test", "-c", "user.email=mmar-test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"], { cwd: directory })
    mkdirSync(installDirectory)
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", directory], { encoding: "utf8" }))[0]
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(directory, packed.filename)], {
      cwd: installDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const pluginDirectory = join(installDirectory, "node_modules", "opencode-multireview-plugin")
    writeFileSync(join(directory, "opencode.json"), JSON.stringify({
      "$schema": "https://opencode.ai/config.json",
      "plugins": [pluginDirectory],
    }))
    const env = isolatedEnvironment(directory)
    const started = await startOpenCodeServer(openCodeV2.bin, directory, env)
    server = started.child
    const hostDirectory = realpathSync(directory)

    const configs = await getJson(started.port, `/api/config?location[directory]=${encodeURIComponent(hostDirectory)}`)
    const projectConfig = configs.find(({ type, path }) => type === "document" && path.endsWith("opencode.json"))
    assert.ok(projectConfig)
    assert.ok(projectConfig.info.plugins.includes(pluginDirectory))
    const installedEntry = realpathSync(join(pluginDirectory, "server.js"))
    const installedPlugin = await waitForPlugin(started.port, `/api/plugin?location[directory]=${encodeURIComponent(hostDirectory)}`, ({ source }) => source.type === "local" && source.path === installedEntry, started.output)
    const serverAgents = await getJson(started.port, `/api/agent?location[directory]=${encodeURIComponent(hostDirectory)}`)
    assert.deepEqual(installedPlugin.state, { status: "active" }, JSON.stringify(installedPlugin))

    const agents = serverAgents
    const bundledNames = agents.filter(({ id }) => id.startsWith("mmar_")).map(({ id }) => id).sort()
    assert.deepEqual(bundledNames, ["mmar_codestyle", "mmar_correctness", "mmar_intent", "mmar_orchestrator", "mmar_testing"])
    for (const agent of agents.filter(({ id }) => id.startsWith("mmar_"))) {
      assert.ok(typeof agent.system === "string" && agent.system.trim(), `${agent.id} has no system prompt`)
    }

    const skillResponse = await fetch(`http://127.0.0.1:${started.port}/api/skill?location[directory]=${encodeURIComponent(hostDirectory)}`, { headers: apiHeaders(), signal: AbortSignal.timeout(10_000) })
    const skillBody = await skillResponse.text()
    assert.equal(skillResponse.ok, true, `skill endpoint returned HTTP ${skillResponse.status}: ${skillBody}`)
    const responseBody = JSON.parse(skillBody)
    const skills = Array.isArray(responseBody) ? responseBody : responseBody.data ?? responseBody
    assert.ok(skills.some(({ id, name }) => id === "mmar" || name?.toLowerCase() === "mmar"), JSON.stringify(skills))
  } finally {
    try {
      await stopOpenCodeServer(server)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})
