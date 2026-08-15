import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { ReviewLifecycleHooks } from "../dist/lifecycleHooks.js"
import { PersistentReviewLifecycle } from "../dist/storage/lifecycle.js"
import { ReviewStore } from "../dist/storage/reviews.js"

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "opencode-multireview-hooks-"))
  return { directory, databasePath: join(directory, "reviews.sqlite") }
}

function identity() {
  return {
    projectKey: "test-project",
    rootPath: "/tmp/test-project",
    gitCommonDir: "/tmp/test-project/.git",
    originUrl: "https://example.test/test-project.git",
    worktreePath: "/tmp/test-project/worktree",
    branch: "feature",
    headCommit: "head",
    isGit: true,
    baseRef: "main",
    baseCommit: "base",
  }
}

function begin(store, sessionID) {
  return store.begin({
    identity: identity(),
    target: { kind: "custom", key: "review", label: "review" },
    sessionID,
  })
}

function taskInput(sessionID) {
  return { tool: "task", sessionID, callID: "call" }
}

function completeStore(store, request) {
  return store.complete({ ...request, laneResults: ["correctness", "codestyle", "testing"].map((lane) => ({ lane, status: "completed" })) })
}

function error(sessionID) {
  return { type: "session.error", properties: sessionID === undefined ? {} : { sessionID } }
}

test("guards specialist dispatches by the active session lock and permits unrelated tasks", () => {
  const { directory, databasePath } = temporaryDatabase()
  try {
    const store = new ReviewStore({ databasePath })
    const lifecycle = new PersistentReviewLifecycle({ databasePath })
    const hooks = new ReviewLifecycleHooks(lifecycle, () => {})
    const owner = "owner-session"
    const contender = "contender-session"

    assert.throws(() => hooks.beforeTool(taskInput(owner), { subagent_type: "mmar_correctness" }), /active review lock/)
    const review = begin(store, owner)
    assert.doesNotThrow(() => hooks.beforeTool(taskInput(owner), { subagent_type: "mmar_correctness" }))
    assert.throws(() => hooks.beforeTool(taskInput(contender), { subagent_type: "mmar_correctness" }), /active review lock/)
    assert.doesNotThrow(() => hooks.beforeTool(taskInput(owner), { subagent_type: "other_agent" }))
    assert.equal(lifecycle.activeReviewForSession(contender), undefined)

    completeStore(store, { reviewId: review.reviewId, roundId: review.roundId, fencingToken: review.fencingToken })
    assert.throws(() => hooks.beforeTool(taskInput(owner), { subagent_type: "mmar_correctness" }), /active review lock/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ignores ordinary idle and records one diagnostic per session error", async () => {
  const { directory, databasePath } = temporaryDatabase()
  try {
    const store = new ReviewStore({ databasePath })
    const lifecycle = new PersistentReviewLifecycle({ databasePath })
    const diagnostics = []
    const hooks = new ReviewLifecycleHooks(lifecycle, (diagnostic) => diagnostics.push(diagnostic))
    const sessionID = "owner-session"
    const review = begin(store, sessionID)

    await hooks.event({ type: "session.idle", properties: { sessionID } })
    await hooks.event({ type: "session.idle", properties: { sessionID } })
    await hooks.event(error(sessionID))
    await hooks.event(error(sessionID))
    await hooks.event(error())
    assert.deepEqual(diagnostics.map(({ event }) => event), ["session.error"])
    assert.equal(lifecycle.activeReviewForSession(sessionID).reviewId, review.reviewId)

    assert.doesNotThrow(() => completeStore(store, {
      reviewId: review.reviewId,
      roundId: review.roundId,
      fencingToken: review.fencingToken,
      sessionID,
    }))
    assert.equal(lifecycle.activeReviewForSession(sessionID), undefined)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("releases a marker after a diagnostic failure so the event can retry", async () => {
  const { directory, databasePath } = temporaryDatabase()
  try {
    const store = new ReviewStore({ databasePath })
    const lifecycle = new PersistentReviewLifecycle({ databasePath })
    const diagnostics = []
    let attempts = 0
    const hooks = new ReviewLifecycleHooks(lifecycle, (diagnostic) => {
      attempts += 1
      if (attempts === 1) throw new Error("sink unavailable")
      diagnostics.push(diagnostic)
    })
    const sessionID = "owner-session"
    const review = begin(store, sessionID)

    await assert.doesNotReject(() => hooks.event(error(sessionID)))
    await hooks.event(error(sessionID))

    assert.equal(attempts, 2)
    assert.deepEqual(diagnostics, [{ event: "session.error", reviewId: review.reviewId, sessionID }])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
