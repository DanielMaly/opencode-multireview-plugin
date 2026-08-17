#!/usr/bin/env node
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Command, CommanderError, Option } from "commander"
import { ReviewStore } from "./storage/reviews.js"
import type { ReviewSummary } from "./review.js"
import { resolveRepositoryIdentity } from "./repository.js"
import { serializeReviewMarkdown } from "./markdown.js"
import { installSkill, type InstallMode } from "./installer.js"

function store(): ReviewStore {
  return new ReviewStore()
}

function formatSummary(summary: ReviewSummary): string {
  const latest = summary.latestRoundId ? `${summary.latestRoundId} (${summary.latestRoundAt})` : "none"
  const intent = summary.currentIntentRef ? `${summary.currentIntentType}:${summary.currentIntentRef}` : "none"
  const lock = summary.lock ? `${summary.lock.fencingToken} (${summary.lock.acquiredAt})` : "none"
  return [
    `Review ${summary.id}`,
    `  Target: ${summary.targetKind} ${summary.targetLabel}`,
    `  Base: ${summary.baseRef} (${summary.baseCommit})`,
    `  Latest round: ${latest}`,
    `  Intent: ${intent}`,
    `  Lock: ${lock}`,
  ].join("\n")
}

function listCommand(options: { allProjects?: boolean; json?: boolean }): void {
  const allProjects = options.allProjects ?? false
  const json = options.json ?? false
  const projectKey = allProjects ? undefined : resolveRepositoryIdentity(process.cwd()).projectKey
  const reviews = store().list(projectKey)
  if (json) {
    process.stdout.write(`${JSON.stringify(reviews, null, 2)}\n`)
    return
  }
  if (reviews.length === 0) {
    process.stdout.write("No reviews found.\n")
    return
  }
  process.stdout.write(`${reviews.map(formatSummary).join("\n\n")}\n`)
}

function findReview(reviewStore: ReviewStore, reviewId: string): ReviewSummary {
  const review = reviewStore.getSummary(reviewId)
  if (!review) throw new Error(`Unknown review: ${reviewId}`)
  return review
}

function writeAtomically(path: string, content: string): void {
  const destination = resolve(path)
  const directory = dirname(destination)
  const temporary = resolve(directory, `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" })
    renameSync(temporary, destination)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw new Error(`Unable to atomically write ${destination}`, { cause: error })
  }
}

function exportCommand(reviewId: string, options: { round?: string; output?: string }): void {
  const { round: roundId, output } = options
  const reviewStore = store()
  const review = findReview(reviewStore, reviewId)
  const round = reviewStore.getRound(reviewId, roundId)
  if (!round) {
    if (roundId) throw new Error(`Unknown round ${roundId} for review ${reviewId}`)
    throw new Error(`Review ${reviewId} has no completed rounds`)
  }
  const markdown = serializeReviewMarkdown({
    reviewId: review.id,
    targetKind: review.targetKind,
    targetLabel: review.targetLabel,
    baseRef: review.baseRef,
    baseCommit: review.baseCommit,
  }, review, round)
  if (output) writeAtomically(output, markdown)
  else process.stdout.write(markdown)
}

async function confirmUnlock(reviewId: string, lock: { acquiredAt: string; fencingToken: string }): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("unlock requires --force when stdin or stdout is non-interactive")
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise<string>((resolveAnswer) => readline.question(`Unlock review ${reviewId} acquired at ${lock.acquiredAt}? [y/N] `, resolveAnswer))
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes"
  } finally {
    readline.close()
  }
}

async function unlockCommand(reviewId: string, options: { force?: boolean }): Promise<void> {
  const force = options.force ?? false
  const reviewStore = store()
  findReview(reviewStore, reviewId)
  const lock = reviewStore.inspectLock(reviewId)
  if (!lock) {
    process.stdout.write(`No active lock for review ${reviewId}.\n`)
    return
  }
  process.stdout.write(`Active lock for review ${reviewId}: ${lock.fencingToken} (acquired ${lock.acquiredAt})\n`)
  if (!force && !(await confirmUnlock(reviewId, lock))) {
    process.stdout.write("Unlock cancelled.\n")
    return
  }
  const deleted = reviewStore.unlock(reviewId, lock.fencingToken)
  process.stdout.write(deleted ? `Unlocked review ${reviewId}.\n` : `Lock for review ${reviewId} was replaced; no lock was removed.\n`)
}

function findingId(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("finding-id must be a positive safe integer")
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("finding-id must be a positive safe integer")
  return id
}

async function promptReason(findingID: number): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("dismiss requires a reason argument when stdin or stdout is non-interactive")
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await new Promise<string>((resolveAnswer) => readline.question(`Reason for dismissing finding ${findingID}: `, resolveAnswer))
  } finally {
    readline.close()
  }
}

function dispositionConfirmation(result: { findingId: number; reviewId: string; roundId: string; disposition: string; idempotent: boolean }): void {
  const status = result.idempotent
    ? `already in effective disposition ${result.disposition}; idempotent no-op`
    : `effective disposition set to ${result.disposition}`
  process.stdout.write(`Finding ${result.findingId} in review ${result.reviewId}, round ${result.roundId}: ${status}.\n`)
}

async function dismissCommand(rawFindingID: string, suppliedReason?: string): Promise<void> {
  const id = findingId(rawFindingID)
  const reason = suppliedReason === undefined ? await promptReason(id) : suppliedReason
  const result = store().setFindingDisposition({ findingId: id, disposition: "ignored", reason })
  dispositionConfirmation(result)
}

function restoreCommand(rawFindingID: string): void {
  const result = store().setFindingDisposition({ findingId: findingId(rawFindingID), disposition: "valid" })
  dispositionConfirmation(result)
}

function skillInstallCommand(options: { global?: boolean; project?: boolean }): void {
  const mode: InstallMode | undefined = options.global ? "global" : options.project ? "project" : undefined
  if (!mode) throw new Error("exactly one of --global or --project is required")
  process.stdout.write(`${installSkill(mode).message}\n`)
}

function commandLine(): Command {
  const program = new Command()
    .name("opencode-multireview")
    .description("Manage OpenCode multireview history and skills")
    .exitOverride()
    .configureOutput({ writeErr: () => undefined })

  program
    .command("list")
    .description("List reviews for the current project")
    .option("--all-projects", "list reviews from all projects")
    .option("--json", "output reviews as JSON")
    .action(listCommand)

  program
    .command("export <review-id>")
    .description("Export a completed review as Markdown")
    .option("--round <round-id>", "export a specific completed round")
    .option("--output <path>", "write the Markdown to a file")
    .action(exportCommand)

  program
    .command("unlock <review-id>")
    .description("Release a review lock")
    .option("--force", "release the lock without confirmation")
    .action(unlockCommand)

  program
    .command("dismiss <finding-id> [reason]")
    .description("Dismiss a latest-round finding with a reason")
    .action(dismissCommand)

  program
    .command("restore <finding-id>")
    .description("Restore a latest-round finding")
    .action(restoreCommand)

  const skill = program
    .command("skill")
    .description("Manage installed multireview skills")
    .action(() => {
      throw new Error(skill.helpInformation())
    })
  skill
    .command("install")
    .description("Install the multireview skill globally or in the project")
    .addOption(new Option("--global", "install in the global skills directory").conflicts("project"))
    .addOption(new Option("--project", "install in the project skills directory").conflicts("global"))
    .action(skillInstallCommand)

  program.action(() => {
    throw new Error(program.helpInformation())
  })
  return program
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  try {
    await commandLine().parseAsync(args, { from: "user" })
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return
    throw error
  }
}

if (process.argv[1] && realpathSync.native(fileURLToPath(import.meta.url)) === realpathSync.native(resolve(process.argv[1]))) {
  main().catch((error: Error) => {
    process.stderr.write(`Error: ${error.message}\n`)
    process.exitCode = 1
  })
}
