import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(moduleDirectory, "..")

export const assetsDirectory = join(packageRoot, "assets")
export const agentsDirectory = join(assetsDirectory, "agents")
export const skillPath = join(assetsDirectory, "skills", "mmar", "SKILL.md")

export function resolveHomePath(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

export function defaultConfigPath(): string {
  return join(homedir(), ".config", "opencode", "multireview-plugin.json")
}

export function globalSkillPath(options: { home?: string; xdgConfigHome?: string } = {}): string {
  const configHome = options.xdgConfigHome ?? (options.home ? join(options.home, ".config") : process.env.XDG_CONFIG_HOME || join(homedir(), ".config"))
  return join(configHome, "opencode", "skills", "mmar", "SKILL.md")
}

export function projectSkillPath(projectRoot: string): string {
  return join(projectRoot, ".opencode", "skills", "mmar", "SKILL.md")
}
