import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { validateBundledMmarSkill } from "../dist/skillDiscovery.js"

test("reports damaged bundled assets with reinstall guidance", () => {
  assert.throws(
    () => validateBundledMmarSkill({ skillsDirectory: "/missing/mmar-skills", skillFilePath: "/missing/mmar-skills/mmar/SKILL.md" }),
    /MMAR package is damaged.*Reinstall opencode-multireview-plugin/,
  )
})
