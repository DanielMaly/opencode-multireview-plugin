import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { assetsDirectory, skillPath } from "./paths.js"

const bundledSkillsDirectory = join(assetsDirectory, "skills")

export type BundledSkillOptions = {
  skillsDirectory?: string
  skillFilePath?: string
}

function packageDamagedError(path: string, cause: unknown): Error {
  return new Error(
    `MMAR package is damaged: bundled MMAR skill assets are missing or unreadable at ${path}. Reinstall opencode-multireview-plugin.`,
    { cause },
  )
}

export function validateBundledMmarSkill(options: BundledSkillOptions = {}): void {
  const skillsDirectory = options.skillsDirectory ?? bundledSkillsDirectory
  const bundledSkillPath = options.skillFilePath ?? (options.skillsDirectory === undefined ? skillPath : join(skillsDirectory, "mmar", "SKILL.md"))

  try {
    if (!statSync(skillsDirectory).isDirectory()) throw new Error("skill directory is not a directory")
    if (!statSync(bundledSkillPath).isFile()) throw new Error("skill file is not a file")
    readFileSync(bundledSkillPath, "utf8")
  } catch (error) {
    throw packageDamagedError(bundledSkillPath, error)
  }
}
