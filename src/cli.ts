#!/usr/bin/env node
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { ReviewStore, type ReviewSummary } from "./storage/reviews.js"
import { resolveRepositoryIdentity } from "./repository.js"
import { serializeReviewMarkdown } from "./markdown.js"

function usage(): never {
  throw new Error([
    "Usage:",
    "  opencode-multireview list [--all-projects] [--json]",
    "  opencode-multireview export <review-id> [--round <round-id>] [--output <path>]",
    "  opencode-multireview unlock <review-id> [--force]",
  ].join("\n"))
}

function optionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`)
  return value
}

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

function listCommand(args: string[]): void {
  let allProjects = false
  let json = false
  for (const arg of args) {
    if (arg === "--all-projects") allProjects = true
    else if (arg === "--json") json = true
    else usage()
  }
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

function findReview(reviewId: string): ReviewSummary {
  const review = store().list(undefined).find((candidate) => candidate.id === reviewId)
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

function exportCommand(args: string[]): void {
  const reviewId = args[0]
  if (!reviewId || reviewId.startsWith("--")) usage()
  let roundId: string | undefined
  let output: string | undefined
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--round") {
      roundId = optionValue(args, index, arg)
      index += 1
    } else if (arg === "--output") {
      output = optionValue(args, index, arg)
      index += 1
    } else usage()
  }
  const review = findReview(reviewId)
  const round = store().getRound(reviewId, roundId)
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

async function unlockCommand(args: string[]): Promise<void> {
  const reviewId = args[0]
  if (!reviewId || reviewId.startsWith("--")) usage()
  let force = false
  for (const arg of args.slice(1)) {
    if (arg === "--force") force = true
    else usage()
  }
  findReview(reviewId)
  const reviewStore = store()
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

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, ...commandArgs] = args
  if (command === "list") listCommand(commandArgs)
  else if (command === "export") exportCommand(commandArgs)
  else if (command === "unlock") await unlockCommand(commandArgs)
  else usage()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: Error) => {
    process.stderr.write(`Error: ${error.message}\n`)
    process.exitCode = 1
  })
}
