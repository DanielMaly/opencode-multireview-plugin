import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { assetsDirectory, skillPath } from "./paths.js"

const bundledSkillsDirectory = join(assetsDirectory, "skills")

export type OpenCodeConfigShape = {
  skills?: unknown
  [key: string]: unknown
}

type SkillsConfig = {
  paths?: unknown
  [key: string]: unknown
}

export type BundledSkillOptions = {
  skillsDirectory?: string
  skillFilePath?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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

function skillsConfig(config: OpenCodeConfigShape): SkillsConfig {
  if (config.skills === undefined) return {}
  if (!isRecord(config.skills)) throw new Error("Invalid OpenCode skills configuration: skills must be an object")
  return config.skills
}

function skillPaths(skills: SkillsConfig): string[] {
  if (skills.paths === undefined) return []
  if (!Array.isArray(skills.paths) || skills.paths.some((path) => typeof path !== "string")) {
    throw new Error("Invalid OpenCode skills configuration: skills.paths must be an array of strings")
  }
  return skills.paths
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)]
}

/** Purely merges a skill search path without mutating the supplied config. */
export function mergeBundledSkillPath(config: OpenCodeConfigShape, skillsDirectory: string): OpenCodeConfigShape {
  const skills = skillsConfig(config)
  const paths = uniquePaths([...skillPaths(skills), skillsDirectory])

  return {
    ...config,
    skills: {
      ...skills,
      paths,
    },
  }
}

/** Validates packaged assets, then returns a new config with bundled discovery enabled. */
export function appendBundledSkillPath(
  config: OpenCodeConfigShape,
  options: BundledSkillOptions = {},
): OpenCodeConfigShape {
  validateBundledMmarSkill(options)
  return mergeBundledSkillPath(config, options.skillsDirectory ?? bundledSkillsDirectory)
}
