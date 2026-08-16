import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { ReviewLifecycleHooks } from "../dist/lifecycleHooks.js"
import { laneRegistry } from "../dist/lanes.js"
import { PersistentReviewLifecycle } from "../dist/storage/lifecycle.js"
import { ReviewStore } from "../dist/storage/reviews.js"
import { openDatabase } from "../dist/storage/database.js"
import { REVIEWER_REGISTRY } from "../dist/defaults.js"

function documentedLanePairs(document) {
  const match = document.match(/Current supported lane\/category pairs are (.+?)\./)
  assert.ok(match)
  return [...match[1].matchAll(/`([^`]+)` \(`([^`]+)`\)/g)].map((pair) => ({ name: pair[1], category: pair[2] }))
}

function identity() {
  return { projectKey: "lane-project", rootPath: "/lane", worktreePath: "/lane", headCommit: "head", isGit: false, baseRef: "main", baseCommit: "base" }
}

function begin(store, lanes, intent) {
  return store.begin({ identity: identity(), target: { kind: "custom", key: Math.random().toString(), label: "lane" }, lanes, intent, sessionID: "session" })
}

function beginWithKey(store, key, lanes, intent) {
  return store.begin({ identity: identity(), target: { kind: "custom", key, label: "lane" }, lanes, intent, sessionID: "session" })
}

function results(lanes, status = "completed") {
  return lanes.map((lane) => ({ lane, status, ...(status === "failed" ? { failureReason: "Dispatch failed" } : {}) }))
}

test("omitted lanes use the backward-compatible defaults and explicit subsets are returned", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-mmar-lanes-default-"))
  try {
    const store = new ReviewStore({ databasePath: join(directory, "reviews.sqlite") })
    assert.deepEqual(begin(store).lanes, ["correctness", "codestyle", "testing"])
    const contended = beginWithKey(store, "contended", ["correctness"])
    const contention = store.begin({ identity: identity(), target: { kind: "custom", key: "contended", label: "changed" }, lanes: ["testing"], sessionID: "session" })
    assert.equal(contention.locked, true)
    assert.deepEqual(contention.lanes, ["correctness"])
    assert.deepEqual(begin(store, undefined, { type: "jira", ref: "MMAR-2" }).lanes, ["correctness", "codestyle", "testing", "intent"])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("supports explicit intent-only reviews with an intent reference", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-mmar-lanes-intent-only-"))
  try {
    const store = new ReviewStore({ databasePath: join(directory, "reviews.sqlite") })
    assert.deepEqual(begin(store, ["intent"], { type: "jira", ref: "MMAR-3" }).lanes, ["intent"])
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
    assert.throws(() => store.complete({ ...review, laneResults: [{ lane: "correctness", status: "completed", failureReason: "not failed" }, { lane: "testing", status: "failed" }] }), /must not include failureReason/)
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

test("canonicalizes lane result keys and normalizes failure reasons", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-mmar-lanes-result-normalization-"))
  try {
    const store = new ReviewStore({ databasePath: join(directory, "reviews.sqlite") })
    const review = begin(store, ["correctness"])
    const first = { ...review, laneResults: [{ status: "failed", failureReason: "  Dispatch\n\n## Injected heading\n- item  ", lane: "correctness" }] }
    assert.deepEqual(store.complete(first), { roundId: review.roundId, idempotent: false })
    const retry = { ...review, laneResults: [{ failureReason: "Dispatch ## Injected heading - item", lane: "correctness", status: "failed" }] }
    assert.deepEqual(store.complete(retry), { roundId: review.roundId, idempotent: true })
    assert.deepEqual(store.getRound(review.reviewId, review.roundId).laneResults, [{ lane: "correctness", status: "failed", failureReason: "Dispatch ## Injected heading - item" }])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("binds completion to the active pending round and rejects lane results for legacy rounds", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-mmar-lanes-binding-"))
  try {
    const databasePath = join(directory, "reviews.sqlite")
    const store = new ReviewStore({ databasePath })
    const review = begin(store, ["correctness"])
    assert.throws(() => store.complete({ ...review, roundId: randomUUID(), laneResults: results(["correctness"]) }), /pending round/)
    assert.equal(store.inspectLock(review.reviewId).fencingToken, review.fencingToken)
    assert.equal(store.getRound(review.reviewId), undefined)

    const database = openDatabase({ databasePath })
    database.prepare("UPDATE review_locks SET pending_round_id = NULL WHERE review_id = ?").run(review.reviewId)
    database.prepare("DELETE FROM review_round_lanes WHERE review_id = ?").run(review.reviewId)
    database.close()
    assert.throws(() => store.complete({ ...review, laneResults: results(["correctness"]) }), /not supported for legacy/)
    assert.doesNotThrow(() => store.complete({ ...review }))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("enforces finding ownership while allowing canonical, alias, and unknown provenance", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-mmar-lanes-ownership-"))
  try {
    const store = new ReviewStore({ databasePath: join(directory, "reviews.sqlite") })
    const outOfCategory = begin(store, ["correctness"])
    assert.throws(() => store.complete({
      ...outOfCategory,
      laneResults: results(["correctness"]),
      validFindings: [{ disposition: "valid", severity: "HIGH", category: "TESTING", title: "wrong category", bodyMarkdown: "evidence", sourceAgents: ["mmar_testing"] }],
    }), /outside the requested MMAR lanes/)
    store.unlock(outOfCategory.reviewId, outOfCategory.fencingToken)

    const omittedAgent = begin(store, ["correctness"])
    assert.throws(() => store.complete({
      ...omittedAgent,
      laneResults: results(["correctness"]),
      validFindings: [{ disposition: "valid", severity: "HIGH", category: "CORRECTNESS", title: "wrong agent", bodyMarkdown: "evidence", sourceAgents: ["mmar_testing"] }],
    }), /outside the requested MMAR lanes/)
    store.unlock(omittedAgent.reviewId, omittedAgent.fencingToken)

    const omittedAlias = begin(store, ["correctness"])
    assert.throws(() => store.complete({
      ...omittedAlias,
      laneResults: results(["correctness"]),
      validFindings: [{ disposition: "valid", severity: "HIGH", category: "CORRECTNESS", title: "wrong alias", bodyMarkdown: "evidence", sourceAgents: ["testing"] }],
    }), /outside the requested MMAR lanes/)
    store.unlock(omittedAlias.reviewId, omittedAlias.fencingToken)

    for (const sourceAgent of ["mmar_correctness", "correctness", "custom_agent"]) {
      const review = begin(store, ["correctness"])
      assert.doesNotThrow(() => store.complete({
        ...review,
        laneResults: results(["correctness"]),
        validFindings: [{ disposition: "valid", severity: "HIGH", category: "CORRECTNESS", title: sourceAgent, bodyMarkdown: "evidence", sourceAgents: [sourceAgent] }],
      }))
    }
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

test("legacy active locks retain unrestricted specialist dispatch", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-mmar-lanes-legacy-dispatch-"))
  try {
    const databasePath = join(directory, "reviews.sqlite")
    const store = new ReviewStore({ databasePath })
    const review = begin(store, ["correctness"])
    const database = openDatabase({ databasePath })
    database.prepare("UPDATE review_locks SET pending_round_id = NULL WHERE review_id = ?").run(review.reviewId)
    database.prepare("DELETE FROM review_round_lanes WHERE review_id = ?").run(review.reviewId)
    database.close()
    const hooks = new ReviewLifecycleHooks(new PersistentReviewLifecycle({ databasePath }), () => {})
    assert.doesNotThrow(() => hooks.beforeTool({ tool: "task", sessionID: "session", callID: "call" }, { subagent_type: "mmar_testing" }))
    store.complete({ ...review })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("filters previous ignored candidates by selected lane and cleans only orphan pending rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-mmar-lanes-cleanup-"))
  try {
    const databasePath = join(directory, "reviews.sqlite")
    const store = new ReviewStore({ databasePath })
    const first = beginWithKey(store, "ignored-history", ["correctness", "testing"])
    store.complete({
      ...first,
      laneResults: results(["correctness", "testing"]),
      ignoredFindings: [
        { disposition: "ignored", severity: "LOW", category: "CORRECTNESS", title: "correctness", bodyMarkdown: "reason", wontfix: "accepted", sourceAgents: ["correctness"] },
        { disposition: "ignored", severity: "LOW", category: "TESTING", title: "testing", bodyMarkdown: "reason", wontfix: "accepted", sourceAgents: ["testing"] },
      ],
    })
    const second = beginWithKey(store, "ignored-history", ["correctness"])
    assert.deepEqual(second.previousIgnored.map((finding) => finding.title), ["correctness"])
    store.unlock(second.reviewId, second.fencingToken)
    const database = openDatabase({ databasePath })
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM review_round_lanes WHERE round_id = ?").get(first.roundId).count, 2)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM review_round_lanes WHERE round_id = ?").get(second.roundId).count, 0)
    database.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("accepts a registry-defined future lane through dispatch and completion", () => {
  const futureLane = { name: "future", specialistAgent: "mmar_future", category: "FUTURE", requiresIntent: false, default: false }
  laneRegistry.push(futureLane)
  const directory = mkdtempSync(join(tmpdir(), "opencode-mmar-lanes-future-"))
  try {
    const databasePath = join(directory, "reviews.sqlite")
    const store = new ReviewStore({ databasePath })
    const review = begin(store, ["future"])
    const hooks = new ReviewLifecycleHooks(new PersistentReviewLifecycle({ databasePath }), () => {})
    assert.doesNotThrow(() => hooks.beforeTool({ tool: "task", sessionID: "session", callID: "call" }, { subagent_type: "mmar_future" }))
    store.complete({ ...review, laneResults: results(["future"]) })
    assert.deepEqual(store.getRound(review.reviewId, review.roundId).lanes, ["future"])
  } finally {
    laneRegistry.splice(laneRegistry.indexOf(futureLane), 1)
    rmSync(directory, { recursive: true, force: true })
  }
})

test("requires the exact intent reference for required-intent lanes", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-mmar-lanes-intent-invariant-"))
  try {
    const store = new ReviewStore({ databasePath: join(directory, "reviews.sqlite") })
    const review = begin(store, ["intent"], { type: "jira", ref: "MMAR-4" })
    const completion = { ...review, laneResults: results(["intent"]) }
    assert.throws(() => store.complete(completion), /intent reference must match/)
    assert.throws(() => store.complete({ ...completion, intent: { type: "jira", ref: "MMAR-5" } }), /intent reference must match/)
    assert.doesNotThrow(() => store.complete({ ...completion, intent: { type: "jira", ref: "MMAR-4" } }))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("completed round retries do not inspect or change a newer active round", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-mmar-lanes-retry-binding-"))
  try {
    const databasePath = join(directory, "reviews.sqlite")
    const store = new ReviewStore({ databasePath })
    const first = beginWithKey(store, "retry-binding", ["correctness"])
    const firstRequest = { ...first, laneResults: results(["correctness"]) }
    store.complete(firstRequest)
    const second = beginWithKey(store, "retry-binding", ["testing"])
    const database = openDatabase({ databasePath })
    const beforeLock = database.prepare("SELECT fencing_token, pending_round_id FROM review_locks WHERE review_id = ?").get(second.reviewId)
    const beforeLanes = database.prepare("SELECT round_id, lane, status FROM review_round_lanes WHERE review_id = ? ORDER BY round_id, lane").all(second.reviewId)
    database.close()

    assert.deepEqual(store.complete(firstRequest), { roundId: first.roundId, idempotent: true })

    const afterDatabase = openDatabase({ databasePath })
    assert.deepEqual(afterDatabase.prepare("SELECT fencing_token, pending_round_id FROM review_locks WHERE review_id = ?").get(second.reviewId), beforeLock)
    assert.deepEqual(afterDatabase.prepare("SELECT round_id, lane, status FROM review_round_lanes WHERE review_id = ? ORDER BY round_id, lane").all(second.reviewId), beforeLanes)
    afterDatabase.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("registered lanes have installed specialists and documented lane metadata", () => {
  const orchestrator = readFileSync(new URL("../assets/agents/mmar_orchestrator.md", import.meta.url), "utf8")
  const skill = readFileSync(new URL("../assets/skills/mmar/SKILL.md", import.meta.url), "utf8")
  const expectedPairs = laneRegistry.map(({ name, category }) => ({ name, category }))
  assert.deepEqual(documentedLanePairs(skill), expectedPairs)
  assert.deepEqual(documentedLanePairs(orchestrator), expectedPairs)
  for (const lane of laneRegistry) {
    assert.equal(REVIEWER_REGISTRY[lane.name]?.name, lane.specialistAgent)
  }
})

test("registry remains the authoritative specialist model", () => {
  assert.deepEqual(laneRegistry.map((lane) => lane.name), ["correctness", "codestyle", "testing", "intent"])
  assert.deepEqual(laneRegistry.map((lane) => lane.specialistAgent), ["mmar_correctness", "mmar_codestyle", "mmar_testing", "mmar_intent"])
})
