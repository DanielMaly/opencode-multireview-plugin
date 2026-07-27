import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { contentSha256, installSkill, provenancePathFor } from "../dist/installer.js"
import { globalSkillPath, projectSkillPath, skillPath } from "../dist/paths.js"
import { runPostinstall } from "../dist/postinstall.js"

const cli = new URL("../dist/cli.js", import.meta.url)
const postinstall = new URL("../dist/postinstall.js", import.meta.url)

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
  assert.match(both.stderr, /mutually exclusive/)
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
  try {
    const result = spawnSync(process.execPath, [join(dist, "cli.js"), "skill", "install", "--project"], { cwd: spaced, encoding: "utf8" })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.ok(existsSync(join(spaced, ".opencode", "skills", "mmar", "SKILL.md")), `${result.stdout}\n${result.stderr}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("noninteractive postinstall skips mutation and prints manual guidance", () => {
  const directory = temporaryDirectory()
  const result = spawnSync(process.execPath, [postinstall.pathname], {
    cwd: directory,
    env: { ...process.env, HOME: directory, XDG_CONFIG_HOME: join(directory, "xdg") },
    encoding: "utf8",
  })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /non-interactive/)
  assert.match(result.stdout, /opencode-multireview skill install --global/)
  assert.equal(existsSync(join(directory, "xdg", "opencode")), false)
  rmSync(directory, { recursive: true, force: true })
})

test("TTY postinstall accepts the default and declines with n", async () => {
  const directory = temporaryDirectory()
  try {
    let installed = false
    await runPostinstall({ isTTY: true, ask: async () => "", install: () => { installed = true } })
    assert.equal(installed, true)

    const messages = []
    await runPostinstall({ isTTY: true, ask: async () => "n", install: () => { throw new Error("must not install") }, write: (message) => messages.push(message) })
    assert.match(messages.join(""), /installation skipped/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("TTY postinstall degrades installer failures to successful manual guidance", async () => {
  const directory = temporaryDirectory()
  try {
    const messages = []
    await runPostinstall({ isTTY: true, ask: async () => "y", install: () => { throw new Error("installation failed") }, write: (message) => messages.push(message) })
    assert.match(messages.join(""), /could not be completed/)
    assert.match(messages.join(""), /opencode-multireview skill install --global/)
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
  assert.ok(files.includes("dist/postinstall.js"))
})

test("packed artifact declares its runtime plugin dependency", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(packageJson.dependencies["@opencode-ai/plugin"], "^1.14.20")
  assert.equal(packageJson.devDependencies["@opencode-ai/plugin"], undefined)
})

test("OpenCode discovers the installed MMAR skill and plugin agents in isolation", { skip: !commandExists("opencode") }, () => {
  const directory = temporaryDirectory()
  const installDirectory = join(directory, "install")
  const xdgConfigHome = join(directory, "xdg")
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
    const pluginPath = join(installDirectory, "node_modules", "opencode-multireview-plugin", "dist", "index.js")
    writeFileSync(join(directory, "opencode.json"), JSON.stringify({
      "$schema": "https://opencode.ai/config.json",
      "plugin": [pathToFileURL(pluginPath).href],
    }))
    const env = {
      ...process.env,
      HOME: join(directory, "home"),
      XDG_CONFIG_HOME: xdgConfigHome,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    }
    delete env.OPENCODE_CONFIG
    delete env.OPENCODE_CONFIG_CONTENT
    const skill = spawnSync("opencode", ["debug", "skill"], { cwd: directory, env, encoding: "utf8" })
    assert.equal(skill.status, 0, `${skill.stdout}\n${skill.stderr}`)
    assert.match(skill.stdout, /"name": "mmar"/)

    const agent = spawnSync("opencode", ["debug", "agent", "mmar_orchestrator"], { cwd: directory, env, encoding: "utf8" })
    assert.equal(agent.status, 0, `${agent.stdout}\n${agent.stderr}`)
    assert.match(agent.stdout, /mmar_orchestrator/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

function commandExists(command) {
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0
}
