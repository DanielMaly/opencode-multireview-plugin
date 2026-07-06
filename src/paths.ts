import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(moduleDirectory, "..")

export const assetsDirectory = join(packageRoot, "assets")
export const agentsDirectory = join(assetsDirectory, "agents")

export function resolveHomePath(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

export function defaultConfigPath(): string {
  return join(homedir(), ".config", "opencode", "multireview-plugin.json")
}
