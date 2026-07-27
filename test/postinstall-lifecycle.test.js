import assert from "node:assert/strict"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import test from "node:test"

const lifecycleScript = new URL("../scripts/postinstall.cjs", import.meta.url)

test("source checkout postinstall succeeds without generated dist", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-multireview-postinstall-"))
  const scripts = join(directory, "scripts")
  try {
    cpSync(lifecycleScript, join(scripts, "postinstall.cjs"))
    const result = spawnSync(process.execPath, [join(scripts, "postinstall.cjs")], {
      cwd: directory,
      env: { ...process.env, HOME: directory, XDG_CONFIG_HOME: join(directory, "xdg") },
      encoding: "utf8",
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /source checkout is not built/)
    assert.match(result.stdout, /npm run build first/)
    assert.match(result.stdout, /opencode-multireview skill install --global/)
    assert.doesNotMatch(result.stdout, /Install skill \(recommended\)/)
    assert.equal(existsSync(join(directory, "xdg", "opencode")), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("published-package wrapper delegates to compiled postinstall and degrades child failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-multireview-postinstall-published-"))
  const scripts = join(directory, "scripts")
  const dist = join(directory, "dist")
  const argumentsPath = join(directory, "arguments.json")
  mkdirSync(scripts, { recursive: true })
  mkdirSync(dist, { recursive: true })
  cpSync(lifecycleScript, join(scripts, "postinstall.cjs"))
  writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }))
  try {
    writeFileSync(join(dist, "postinstall.js"), [
      'import { writeFileSync } from "node:fs"',
      `writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)))`,
      'process.stdout.write("compiled postinstall ran\\n")',
    ].join("\n"))
    const success = spawnSync(process.execPath, [join(scripts, "postinstall.cjs")], { cwd: directory, encoding: "utf8" })
    assert.equal(success.status, 0, `${success.stdout}\n${success.stderr}`)
    assert.match(success.stdout, /compiled postinstall ran/)
    assert.deepEqual(JSON.parse(readFileSync(argumentsPath, "utf8")), [])

    writeFileSync(join(dist, "postinstall.js"), 'process.stdout.write("compiled postinstall failed\\n"); process.exitCode = 7\n')
    const failure = spawnSync(process.execPath, [join(scripts, "postinstall.cjs")], { cwd: directory, encoding: "utf8" })
    assert.equal(failure.status, 0, `${failure.stdout}\n${failure.stderr}`)
    assert.match(failure.stdout, /compiled postinstall failed/)
    assert.match(failure.stdout, /could not be completed/)
    assert.match(failure.stdout, /opencode-multireview skill install --global/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
