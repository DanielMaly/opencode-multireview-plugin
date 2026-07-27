import { createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

export type TargetKind = "pull_request" | "branch" | "commit" | "uncommitted" | "custom"

export interface TargetInput {
  kind: TargetKind
  label?: string
  provider?: string
  repository?: string
  number?: number
  branch?: string
  commit?: string
  changeset?: string
}

export interface NormalizedTarget {
  kind: TargetKind
  key: string
  label: string
  provider?: string
  repository?: string
  number?: number
}

export interface RepositoryIdentity {
  projectKey: string
  rootPath: string
  gitCommonDir?: string
  originUrl?: string
  worktreePath: string
  branch?: string
  headCommit: string
  isGit: boolean
}

export interface ResolvedBase {
  baseRef: string
  baseCommit: string
}

export interface ResolvedReviewIdentity extends RepositoryIdentity, ResolvedBase {}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

function hasGitMetadata(cwd: string): boolean {
  let directory = cwd
  while (true) {
    if (existsSync(resolve(directory, ".git"))) return true
    const parent = dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
}

function git(cwd: string, args: string[], optional = false): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined
  } catch (error) {
    const status = (error as { status?: number }).status
    if (optional && status === 1) return undefined
    throw new Error(`Git command failed in ${cwd}: git ${args.join(" ")}`, { cause: error })
  }
}

function requiredGit(cwd: string, args: string[], description: string): string {
  const value = git(cwd, args)
  if (!value) throw new Error(`Unable to resolve ${description} in ${cwd}`)
  return value
}

export function resolveRepositoryIdentity(cwd: string): RepositoryIdentity {
  const worktreePath = canonicalPath(cwd)
  let gitRoot: string | undefined
  try {
    gitRoot = git(worktreePath, ["rev-parse", "--show-toplevel"])
  } catch (error) {
    if (hasGitMetadata(worktreePath)) {
      throw new Error(`Git repository detection failed in ${worktreePath}`, { cause: error })
    }
    gitRoot = undefined
  }
  if (!gitRoot) {
    const rootPath = worktreePath
    return {
      projectKey: createHash("sha256").update(rootPath).digest("hex"),
      rootPath,
      worktreePath,
      headCommit: "",
      isGit: false,
    }
  }
  const rootPath = canonicalPath(gitRoot)
  const commonDirValue = requiredGit(worktreePath, ["rev-parse", "--git-common-dir"], "Git common directory")
  const gitCommonDir = canonicalPath(resolve(worktreePath, commonDirValue))
  const headCommit = requiredGit(worktreePath, ["rev-parse", "HEAD"], "HEAD")
  return {
    projectKey: createHash("sha256").update(gitCommonDir).digest("hex"),
    rootPath,
    gitCommonDir,
    originUrl: git(worktreePath, ["config", "--get", "remote.origin.url"], true),
    worktreePath,
    branch: git(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"], true),
    headCommit,
    isGit: true,
  }
}

export function resolveBase(cwd: string, baseRef: string): ResolvedBase {
  if (baseRef.trim() === "" || /[\0\r\n]/.test(baseRef)) throw new Error("base_ref must be a non-empty Git ref")
  let baseCommit: string | undefined
  try {
    baseCommit = execFileSync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status !== 128) throw new Error(`Git base resolution failed in ${cwd}`, { cause: error })
  }
  if (!baseCommit) throw new Error(`Unable to resolve base ref "${baseRef}"`)
  return { baseRef, baseCommit }
}

export function resolveReviewIdentity(cwd: string, baseRef: string): ResolvedReviewIdentity {
  return { ...resolveRepositoryIdentity(cwd), ...resolveBase(cwd, baseRef) }
}

function nonEmpty(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

export function normalizeTarget(target: TargetInput, identity: RepositoryIdentity): NormalizedTarget {
  if (target.kind === "pull_request") {
    const provider = nonEmpty("pull request provider", target.provider)
    const repository = nonEmpty("pull request repository", target.repository)
    if (!Number.isInteger(target.number) || target.number! < 1) throw new Error("pull request number must be a positive integer")
    return { kind: target.kind, key: `${provider}/${repository}#${target.number}`, label: target.label?.trim() || `${repository}#${target.number}`, provider, repository, number: target.number }
  }
  if (target.kind === "branch") {
    const branch = nonEmpty("branch", target.branch ?? target.label)
    return { kind: target.kind, key: branch, label: target.label?.trim() || branch }
  }
  if (target.kind === "commit") {
    const commit = nonEmpty("commit", target.commit ?? target.label)
    return { kind: target.kind, key: commit, label: target.label?.trim() || commit }
  }
  if (target.kind === "uncommitted") {
    return { kind: target.kind, key: identity.worktreePath, label: target.label?.trim() || `${basename(identity.worktreePath)} (uncommitted)` }
  }
  const changeset = nonEmpty("custom changeset", target.changeset ?? target.label)
  return { kind: target.kind, key: changeset, label: target.label?.trim() || changeset }
}

export function newReviewId(): string {
  return randomUUID()
}
