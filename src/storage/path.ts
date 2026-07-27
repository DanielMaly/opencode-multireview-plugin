import { chmodSync, mkdirSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, join } from "node:path"

export interface DatabasePathOptions {
  home?: string
  dataHome?: string
  platformName?: NodeJS.Platform
}

export function resolveDatabasePath(options: DatabasePathOptions = {}): string {
  const operatingSystem = options.platformName ?? platform()
  const home = options.home ?? homedir()
  if (operatingSystem === "darwin") return join(home, "Library", "Application Support", "opencode-multireview", "reviews.sqlite")
  if (operatingSystem === "win32") {
    const localAppData = options.dataHome ?? process.env.LOCALAPPDATA ?? join(home, "AppData", "Local")
    return join(localAppData, "opencode-multireview", "reviews.sqlite")
  }
  const dataHome = options.dataHome ?? process.env.XDG_DATA_HOME ?? join(home, ".local", "share")
  return join(dataHome, "opencode-multireview", "reviews.sqlite")
}

export function ensureDatabaseDirectory(databasePath: string): void {
  const directory = dirname(databasePath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") chmodSync(directory, 0o700)
}
