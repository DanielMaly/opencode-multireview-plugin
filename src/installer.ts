import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveRepositoryIdentity } from "./repository.js"
import { globalSkillPath, projectSkillPath, skillPath } from "./paths.js"

export type InstallMode = "global" | "project"

export type InstallResult = {
  mode: InstallMode
  skillPath: string
  provenancePath: string
  status: "installed" | "updated" | "unchanged" | "preserved"
  message: string
}

type Provenance = {
  packageName: string
  packageVersion: string
  contentSha256: string
}

type AtomicWriter = (path: string, content: string) => void

const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json")
const packageMetadata = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name: string; version: string }

export function contentSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

export function provenancePathFor(skillFilePath: string): string {
  return `${skillFilePath}.provenance.json`
}

export function resolveInstallPath(mode: InstallMode, cwd = process.cwd()): string {
  if (mode === "global") return globalSkillPath()
  return projectSkillPath(resolveRepositoryIdentity(cwd).rootPath)
}

function writeAtomically(path: string, content: string): void {
  const destination = resolve(path)
  const directory = dirname(destination)
  const temporary = join(directory, `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 })
    renameSync(temporary, destination)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw new Error(`Unable to install ${destination}`, { cause: error })
  }
}

function readProvenance(path: string): Provenance | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Provenance>
    if (typeof value.packageName !== "string" || typeof value.packageVersion !== "string" || typeof value.contentSha256 !== "string") return undefined
    return value as Provenance
  } catch {
    return undefined
  }
}

function provenance(content: string): string {
  return `${JSON.stringify({
    packageName: packageMetadata.name,
    packageVersion: packageMetadata.version,
    contentSha256: contentSha256(content),
  }, null, 2)}\n`
}

export function installSkill(mode: InstallMode, cwd = process.cwd(), atomicWriter: AtomicWriter = writeAtomically): InstallResult {
  const destination = resolveInstallPath(mode, cwd)
  const sidecar = provenancePathFor(destination)
  const desired = readFileSync(skillPath, "utf8")
  const hasSkill = existsSync(destination)
  if (!hasSkill) {
    atomicWriter(sidecar, provenance(desired))
    atomicWriter(destination, desired)
    return { mode, skillPath: destination, provenancePath: sidecar, status: "installed", message: `Installed MMAR skill at ${destination}` }
  }

  const current = readFileSync(destination, "utf8")
  const owner = readProvenance(sidecar)
  if (!owner || owner.packageName !== packageMetadata.name || owner.contentSha256 !== contentSha256(current)) {
    return { mode, skillPath: destination, provenancePath: sidecar, status: "preserved", message: `Preserved modified or unowned MMAR skill at ${destination}` }
  }
  if (current === desired && owner.packageVersion === packageMetadata.version) {
    return { mode, skillPath: destination, provenancePath: sidecar, status: "unchanged", message: `MMAR skill is current at ${destination}` }
  }

  atomicWriter(sidecar, provenance(desired))
  atomicWriter(destination, desired)
  return { mode, skillPath: destination, provenancePath: sidecar, status: "updated", message: `Updated MMAR skill at ${destination}` }
}
