import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { openDatabase } from "../dist/storage/database.js"
import { ReviewStore } from "../dist/storage/reviews.js"

function identity(directory) {
  return {
    projectKey: "bun-project",
    rootPath: directory,
    gitCommonDir: undefined,
    originUrl: undefined,
    worktreePath: directory,
    branch: undefined,
    headCommit: "head",
    isGit: false,
    baseRef: "base",
    baseCommit: "base-commit",
  }
}

function target(key) {
  return { kind: "custom", key, label: key }
}

function validFinding(title = "Keep this") {
  return {
    disposition: "valid",
    severity: "HIGH",
    category: "CORRECTNESS",
    title,
    bodyMarkdown: "The body",
    sourceAgents: ["correctness"],
  }
}

test("Bun completes a durable no-intent round", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-multireview-bun-"))
  try {
    const store = new ReviewStore({ databasePath: join(directory, "reviews.sqlite") })
    const review = store.begin({
      identity: identity(directory),
      target: target("bun-smoke"),
    })

    assert.equal(review.locked, false)
    assert.deepEqual(store.complete({
      reviewId: review.reviewId,
      roundId: review.roundId,
      fencingToken: review.fencingToken,
      laneResults: ["correctness", "codestyle", "testing"].map((lane) => ({ lane, status: "completed" })),
    }), { roundId: review.roundId, idempotent: false })
    assert.equal(store.getRound(review.reviewId)?.ordinal, 1)
    assert.equal(store.getRound(review.reviewId)?.intent, undefined)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Bun normalizes no-row reads to undefined", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-multireview-bun-no-row-"))
  const databasePath = join(directory, "reviews.sqlite")
  try {
    const database = openDatabase({ databasePath })
    assert.equal(database.prepare("SELECT id FROM reviews WHERE id = ?").get("missing"), undefined)
    database.close()

    const store = new ReviewStore({ databasePath })
    assert.equal(store.inspectLock("missing"), undefined)
    const review = store.begin({ identity: identity(directory), target: target("no-row") })
    assert.equal(store.getRound(review.reviewId), undefined)
    store.complete({
      reviewId: review.reviewId,
      roundId: review.roundId,
      fencingToken: review.fencingToken,
      laneResults: ["correctness", "codestyle", "testing"].map((lane) => ({ lane, status: "completed" })),
    })
    assert.equal(store.inspectLock(review.reviewId), undefined)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Bun preserves contention and fencing behavior for replaced tokens", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-multireview-bun-lock-"))
  const databasePath = join(directory, "reviews.sqlite")
  try {
    const store = new ReviewStore({ databasePath })
    const first = store.begin({ identity: identity(directory), target: target("lock") })
    const contention = store.begin({ identity: identity(directory), target: target("lock") })
    assert.equal(contention.locked, true)
    assert.equal(contention.reviewId, first.reviewId)
    assert.equal("roundId" in contention, false)

    assert.equal(store.unlock(first.reviewId, first.fencingToken), true)
    const replacement = store.begin({ identity: identity(directory), target: target("lock") })
    assert.notEqual(replacement.fencingToken, first.fencingToken)
    assert.throws(
      () => store.complete({ reviewId: first.reviewId, roundId: first.roundId, fencingToken: first.fencingToken, laneResults: ["correctness", "codestyle", "testing"].map((lane) => ({ lane, status: "completed" })), validFindings: [validFinding()] }),
      /stale or missing/,
    )
    assert.deepEqual(store.inspectLock(first.reviewId), {
      reviewId: first.reviewId,
      fencingToken: replacement.fencingToken,
      acquiredAt: replacement.acquiredAt,
    })
    assert.deepEqual(store.complete({
      reviewId: replacement.reviewId,
      roundId: replacement.roundId,
      fencingToken: replacement.fencingToken,
      laneResults: ["correctness", "codestyle", "testing"].map((lane) => ({ lane, status: "completed" })),
      validFindings: [validFinding("Replacement")],
    }), { roundId: replacement.roundId, idempotent: false })
    assert.equal(store.inspectLock(first.reviewId), undefined)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Bun rolls back failed completion and preserves its lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-multireview-bun-rollback-"))
  const databasePath = join(directory, "reviews.sqlite")
  try {
    const store = new ReviewStore({ databasePath })
    const review = store.begin({ identity: identity(directory), target: target("rollback") })
    const database = openDatabase({ databasePath })
    database.exec("CREATE TRIGGER fail_findings BEFORE INSERT ON findings BEGIN SELECT RAISE(ABORT, 'forced completion failure'); END")
    database.close()

    assert.throws(
      () => store.complete({ reviewId: review.reviewId, roundId: review.roundId, fencingToken: review.fencingToken, laneResults: ["correctness", "codestyle", "testing"].map((lane) => ({ lane, status: "completed" })), validFindings: [validFinding()] }),
      /forced completion failure/,
    )
    assert.equal(store.getRound(review.reviewId), undefined)
    assert.deepEqual(store.inspectLock(review.reviewId), {
      reviewId: review.reviewId,
      fencingToken: review.fencingToken,
      acquiredAt: review.acquiredAt,
    })

    const afterFailure = openDatabase({ databasePath })
    assert.equal(afterFailure.prepare("SELECT COUNT(*) AS count FROM review_rounds WHERE review_id = ?").get(review.reviewId).count, 0)
    afterFailure.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
