import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { appendBundledSkillPath, mergeBundledSkillPath, validateBundledMmarSkill } from "../dist/skillDiscovery.js"

function temporaryAssets() {
  const directory = mkdtempSync(join(tmpdir(), "opencode-multireview-skill-discovery-"))
  const skillsDirectory = join(directory, "skills")
  const skillFilePath = join(skillsDirectory, "mmar", "SKILL.md")
  mkdirSync(join(skillsDirectory, "mmar"), { recursive: true })
  writeFileSync(skillFilePath, "---\nname: mmar\n---\n", "utf8")
  return { directory, skillsDirectory, skillFilePath }
}

test("merges bundled discovery without mutating config and preserves order and fields", () => {
  const config = {
    command: "keep",
    skills: {
      paths: ["first", "bundled", "first"],
      urls: ["https://example.invalid/skills"],
      other: { enabled: true },
    },
  }

  const merged = mergeBundledSkillPath(config, "bundled")

  assert.deepEqual(merged, {
    command: "keep",
    skills: {
      paths: ["first", "bundled"],
      urls: ["https://example.invalid/skills"],
      other: { enabled: true },
    },
  })
  assert.deepEqual(config.skills.paths, ["first", "bundled", "first"])
})

test("adds skills configuration when it is omitted", () => {
  const merged = mergeBundledSkillPath({ project: true }, "bundled")

  assert.deepEqual(merged, { project: true, skills: { paths: ["bundled"] } })
})

test("validates packaged assets before adding them", () => {
  const assets = temporaryAssets()
  try {
    const merged = appendBundledSkillPath({ skills: { urls: ["url"] } }, assets)
    assert.deepEqual(merged.skills, { urls: ["url"], paths: [assets.skillsDirectory] })
  } finally {
    rmSync(assets.directory, { recursive: true, force: true })
  }
})

test("reports damaged bundled assets with reinstall guidance", () => {
  assert.throws(
    () => validateBundledMmarSkill({ skillsDirectory: "/missing/mmar-skills", skillFilePath: "/missing/mmar-skills/mmar/SKILL.md" }),
    /MMAR package is damaged.*Reinstall opencode-multireview-plugin/,
  )
})

test("rejects malformed skills paths without mutating config", () => {
  const config = { skills: { paths: ["ok", 42] } }

  assert.throws(() => mergeBundledSkillPath(config, "bundled"), /skills\.paths must be an array of strings/)
  assert.deepEqual(config, { skills: { paths: ["ok", 42] } })
})
