import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { ReviewLifecycleHooks } from "../dist/lifecycleHooks.js"
import { laneRegistry } from "../dist/lanes.js"
import { PersistentReviewLifecycle } from "../dist/storage/lifecycle.js"
import { ReviewStore } from "../dist/storage/reviews.js"

function identity() {
  return { projectKey: "lane-project", rootPath: "/lane", worktreePath: "/lane", headCommit: "head", isGit: false, baseRef: "main", baseCommit: "base" }
}

function begin(store, lanes, intent) {
  return store.begin({ identity: identity(), target: { kind: "custom", key: Math.random().toString(), label: "lane" }, lanes, intent, sessionID: "session" })
}

function results(lanes, status = "completed") {
  return lanes.map((lane) => ({ lane, status, ...(status === "failed" ? { failureReason: "Dispatch failed" } : {}) }))
}

test("omitted lanes use the backward-compatible defaults and explicit subsets are returned", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-mmar-lanes-default-"))
  try {
    const store = new ReviewStore({ databasePath: join(directory, "reviews.sqlite") })
    assert.deepEqual(begin(store).lanes, ["correctness", "codestyle", "testing"])
    assert.deepEqual(begin(store, ["correctness"]).lanes, ["correctness"])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("validates intent, empty, duplicate, and unknown lane requests", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-mmar-lanes-validation-"))
  try {
    const store = new ReviewStore({ databasePath: join(directory, "reviews.sqlite") })
    assert.throws(() => begin(store, ["intent"]), /requires an intent reference/)
    assert.throws(() => begin(store, []), /at least one lane/)
    assert.throws(() => begin(store, ["correctness", "correctness"]), /duplicates/)
    assert.throws(() => begin(store, ["future"]), /unknown MMAR lane/)
    assert.deepEqual(begin(store, ["correctness"], { type: "jira", ref: "MMAR-1" }).lanes, ["correctness"])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("requires exact terminal lane results and reads zero-finding and failed outcomes", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-mmar-lanes-results-"))
  try {
    const store = new ReviewStore({ databasePath: join(directory, "reviews.sqlite") })
    const review = begin(store, ["correctness", "testing"])
    assert.throws(() => store.complete({ ...review }), /laneResults are required/)
    assert.throws(() => store.complete({ ...review, laneResults: results(["correctness"]) }), /every requested lane/)
    assert.throws(() => store.complete({ ...review, laneResults: results(["correctness", "testing", "codestyle"]) }), /every requested lane/)
    assert.throws(() => store.complete({ ...review, laneResults: [{ lane: "correctness", status: "completed" }, { lane: "correctness", status: "completed" }] }), /duplicates/)
    store.complete({ ...review, laneResults: [{ lane: "correctness", status: "completed" }, { lane: "testing", status: "failed", failureReason: "Dispatch failed" }] })
    const round = store.getRound(review.reviewId, review.roundId)
    assert.deepEqual(round.lanes, ["correctness", "testing"])
    assert.deepEqual(round.laneResults, [{ lane: "correctness", status: "completed" }, { lane: "testing", status: "failed", failureReason: "Dispatch failed" }])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("lane results participate in idempotent completion hashing", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-mmar-lanes-hash-"))
  try {
    const store = new ReviewStore({ databasePath: join(directory, "reviews.sqlite") })
    const review = begin(store, ["correctness"])
    const request = { ...review, laneResults: [{ lane: "correctness", status: "completed" }] }
    assert.equal(store.complete(request).idempotent, false)
    assert.equal(store.complete(request).idempotent, true)
    assert.throws(() => store.complete({ ...request, laneResults: [{ lane: "correctness", status: "failed" }] }), /payload differs/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("native specialist dispatch is rejected for an omitted lane", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-mmar-lanes-dispatch-"))
  try {
    const databasePath = join(directory, "reviews.sqlite")
    const store = new ReviewStore({ databasePath })
    const lifecycle = new PersistentReviewLifecycle({ databasePath })
    const hooks = new ReviewLifecycleHooks(lifecycle, () => {})
    const review = store.begin({ identity: identity(), target: { kind: "custom", key: "dispatch", label: "dispatch" }, lanes: ["correctness"], sessionID: "session" })
    assert.doesNotThrow(() => hooks.beforeTool({ tool: "task", sessionID: "session", callID: "call" }, { subagent_type: "mmar_correctness" }))
    assert.throws(() => hooks.beforeTool({ tool: "task", sessionID: "session", callID: "call" }, { subagent_type: "mmar_testing" }), /outside the active review lanes/)
    store.complete({ ...review, laneResults: [{ lane: "correctness", status: "completed" }] })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("registry remains the authoritative specialist model", () => {
  assert.deepEqual(laneRegistry.map((lane) => lane.name), ["correctness", "codestyle", "testing", "intent"])
  assert.deepEqual(laneRegistry.map((lane) => lane.specialistAgent), ["mmar_correctness", "mmar_codestyle", "mmar_testing", "mmar_intent"])
})
