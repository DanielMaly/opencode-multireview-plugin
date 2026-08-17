import { randomUUID } from "node:crypto"
import type { DatabaseOptions, SqliteDatabase } from "./database.js"
import { immediateTransaction, withDatabase } from "./database.js"
import {
  hashRoundPayload,
  normalizeRoundPayload,
} from "../findings.js"
import type { NormalizedRoundPayload } from "../findings.js"
import { newReviewId } from "../repository.js"
import { intentValues, LEGACY_SESSION_ID, sessionValue, type BeginReviewRequest, type BeginReviewResult, type CompleteReviewRequest } from "../review.js"
import { previousIgnored } from "./reviewReads.js"
import { activeLaneSnapshot, resolveMarkers } from "./reviewLifecycle.js"
import { laneByName, normalizeLanes, validateFindingOwnership, type ReviewLane } from "../lanes.js"
import type { LaneResult } from "../review.js"

const ACTIVE_LOCK_QUERY = "SELECT l.fencing_token, l.pending_round_id, l.session_id, r.current_intent_type, r.current_intent_ref, (SELECT COUNT(*) FROM review_round_lanes WHERE review_id = l.review_id) AS lane_count FROM review_locks l JOIN reviews r ON r.id = l.review_id WHERE l.review_id = ?"
const PROJECT_QUERY = "SELECT id FROM projects WHERE project_key = ?"
const REVIEW_QUERY = "SELECT id, target_kind FROM reviews WHERE project_id = ? AND target_key = ? AND base_commit = ?"
const LOCK_QUERY = "SELECT fencing_token, acquired_at FROM review_locks WHERE review_id = ?"
const UPDATE_PROJECT_QUERY = "UPDATE projects SET root_path = ?, git_common_dir = ?, origin_url = ?, last_seen_at = ? WHERE id = ?"
const INSERT_PROJECT_QUERY = "INSERT INTO projects (project_key, root_path, git_common_dir, origin_url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)"
const WORKTREE_QUERY = "SELECT id FROM worktrees WHERE project_id = ? AND path = ?"
const UPDATE_WORKTREE_QUERY = "UPDATE worktrees SET last_seen_at = ? WHERE id = ?"
const INSERT_WORKTREE_QUERY = "INSERT INTO worktrees (project_id, path, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)"
const UPDATE_REVIEW_QUERY = "UPDATE reviews SET worktree_id = ?, target_kind = ?, target_label = ?, base_ref = ?, branch = ?, head_commit = ?, pr_provider = ?, pr_repository = ?, pr_number = ?, updated_at = ? WHERE id = ?"
const INSERT_REVIEW_QUERY = "INSERT INTO reviews (id, project_id, worktree_id, target_kind, target_key, target_label, base_ref, base_commit, branch, head_commit, pr_provider, pr_repository, pr_number, current_intent_type, current_intent_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
const UPDATE_CURRENT_INTENT_QUERY = "UPDATE reviews SET current_intent_type = ?, current_intent_ref = ?, updated_at = ? WHERE id = ?"
const INSERT_LOCK_QUERY = "INSERT INTO review_locks (review_id, fencing_token, acquired_at, session_id) VALUES (?, ?, ?, ?)"
const UPDATE_PENDING_ROUND_QUERY = "UPDATE review_locks SET pending_round_id = ? WHERE review_id = ? AND fencing_token = ?"
const INSERT_ROUND_LANE_QUERY = "INSERT INTO review_round_lanes (round_id, review_id, lane, status, failure_reason, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)"
const EXISTING_ROUND_QUERY = "SELECT payload_hash, completed_session_id FROM review_rounds WHERE id = ? AND review_id = ?"
const ROUND_LANES_QUERY = "SELECT lane, status, failure_reason FROM review_round_lanes WHERE round_id = ? AND review_id = ? ORDER BY lane"
const ROUND_INTENT_QUERY = "SELECT intent_type, intent_ref FROM review_rounds WHERE id = ? AND review_id = ?"
const UPDATE_COMPLETED_SESSION_QUERY = "UPDATE review_rounds SET completed_session_id = ? WHERE id = ? AND review_id = ? AND completed_session_id IS NULL"
const LATEST_ROUND_QUERY = "SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM review_rounds WHERE review_id = ?"
const INSERT_ROUND_QUERY = "INSERT INTO review_rounds (id, review_id, ordinal, payload_hash, intent_type, intent_ref, completed_at, completed_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
const UPDATE_ROUND_LANE_QUERY = "UPDATE review_round_lanes SET status = ?, failure_reason = ?, updated_at = ? WHERE round_id = ? AND review_id = ? AND lane = ?"
const INSERT_UNCERTAINTY_QUERY = "INSERT INTO intent_uncertainties (round_id, ordinal, title, observed_evidence, missing_context, clarification_question) VALUES (?, ?, ?, ?, ?, ?)"
const INSERT_FINDING_QUERY = "INSERT INTO findings (round_id, ordinal, disposition, severity, category, title, body_markdown, wontfix, source_agents_json, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
const INSERT_FINDING_BLOCK_QUERY = "INSERT INTO finding_intent_blocks (finding_id, uncertainty_id) VALUES (?, ?)"
const DELETE_LOCK_QUERY = "DELETE FROM review_locks WHERE review_id = ? AND fencing_token = ?"

type ProjectRow = { id: number }
type ExistingReviewRow = { id: string; target_kind: string }
type LockRow = { fencing_token: string; acquired_at: string }
type WorktreeRow = { id: number }
type ExistingRoundRow = { payload_hash: string; completed_session_id: string | null }
type ActiveLockRow = {
  fencing_token: string
  pending_round_id: string | null
  session_id: string
  current_intent_type: string | null
  current_intent_ref: string | null
  lane_count: number
}
type LaneRow = { lane: string; status: "completed" | "failed" | null; failure_reason: string | null }
type ExpectedIntentRow = { intent_type: string | null; intent_ref: string | null }
type LatestRoundRow = { ordinal: number }
type CompleteResult = { roundId: string; idempotent: boolean }

function now(): string {
  return new Date().toISOString()
}

export function begin(options: DatabaseOptions, request: BeginReviewRequest): BeginReviewResult {
  const lanes = normalizeLanes(request.lanes, request.intent !== undefined && request.intent !== null)
  return withDatabase(options, (database) => immediateTransaction(database, () => beginReview(database, request, lanes)))
}

export function complete(options: DatabaseOptions, request: CompleteReviewRequest): CompleteResult {
  return withDatabase(options, (database) => immediateTransaction(database, () => completeReview(database, request)))
}

function beginReview(database: SqliteDatabase, request: BeginReviewRequest, lanes: ReviewLane[]): BeginReviewResult {
  const timestamp = now()
  const identity = request.identity
  const project = database.prepare(PROJECT_QUERY).get(identity.projectKey) as ProjectRow | undefined
  const existing = project
    ? database.prepare(REVIEW_QUERY).get(project.id, request.target.key, identity.baseCommit) as ExistingReviewRow | undefined
    : undefined
  if (existing && existing.target_kind !== request.target.kind) throw new Error("review target kind does not match existing review identity")
  const stableReviewId = existing?.id ?? newReviewId()
  const lock = existing
    ? database.prepare(LOCK_QUERY).get(existing.id) as LockRow | undefined
    : undefined
  if (existing && lock) {
    const activeLanes = activeLaneSnapshot(database, existing.id)
    return { reviewId: existing.id, locked: true, acquiredAt: lock.acquired_at, previousIgnored: [], lanes: activeLanes.lanes }
  }
  const projectId = persistProject(database, project, request, timestamp)
  const worktreeId = persistWorktree(database, projectId, request, timestamp)
  const [intentType, intentRef] = intentValues(request.intent)
  persistReview(database, existing, request, projectId, worktreeId, stableReviewId, timestamp, intentType, intentRef)
  const previousRows = previousIgnored(database, stableReviewId, lanes)
  const fencingToken = randomUUID()
  const roundId = randomUUID()
  const sessionID = sessionValue(request.sessionID)
  persistPendingRound(database, stableReviewId, roundId, fencingToken, timestamp, sessionID, lanes)
  return {
    reviewId: stableReviewId,
    roundId,
    fencingToken,
    acquiredAt: timestamp,
    locked: false,
    previousIgnored: previousRows,
    lanes,
  }
}

function persistProject(database: SqliteDatabase, project: ProjectRow | undefined, request: BeginReviewRequest, timestamp: string): number {
  const identity = request.identity
  if (project) {
    database.prepare(UPDATE_PROJECT_QUERY).run(
      identity.rootPath,
      identity.gitCommonDir ?? null,
      identity.originUrl ?? null,
      timestamp,
      project.id,
    )
    return project.id
  }
  const result = database.prepare(INSERT_PROJECT_QUERY).run(
    identity.projectKey,
    identity.rootPath,
    identity.gitCommonDir ?? null,
    identity.originUrl ?? null,
    timestamp,
    timestamp,
  )
  return Number(result.lastInsertRowid)
}

function persistWorktree(database: SqliteDatabase, projectId: number, request: BeginReviewRequest, timestamp: string): number {
  const worktree = database.prepare(WORKTREE_QUERY).get(projectId, request.identity.worktreePath) as WorktreeRow | undefined
  if (worktree) {
    database.prepare(UPDATE_WORKTREE_QUERY).run(timestamp, worktree.id)
    return worktree.id
  }
  const result = database.prepare(INSERT_WORKTREE_QUERY).run(projectId, request.identity.worktreePath, timestamp, timestamp)
  return Number(result.lastInsertRowid)
}

function persistReview(
  database: SqliteDatabase,
  existing: ExistingReviewRow | undefined,
  request: BeginReviewRequest,
  projectId: number,
  worktreeId: number,
  reviewId: string,
  timestamp: string,
  intentType: string | null,
  intentRef: string | null,
): void {
  const identity = request.identity
  if (existing) {
    database.prepare(UPDATE_REVIEW_QUERY).run(
      worktreeId,
      request.target.kind,
      request.target.label,
      identity.baseRef,
      identity.branch ?? null,
      identity.headCommit || null,
      request.target.provider ?? null,
      request.target.repository ?? null,
      request.target.number ?? null,
      timestamp,
      reviewId,
    )
  } else {
    database.prepare(INSERT_REVIEW_QUERY).run(
      reviewId,
      projectId,
      worktreeId,
      request.target.kind,
      request.target.key,
      request.target.label,
      identity.baseRef,
      identity.baseCommit,
      identity.branch ?? null,
      identity.headCommit || null,
      request.target.provider ?? null,
      request.target.repository ?? null,
      request.target.number ?? null,
      intentType,
      intentRef,
      timestamp,
      timestamp,
    )
  }
  database.prepare(UPDATE_CURRENT_INTENT_QUERY).run(intentType, intentRef, timestamp, reviewId)
}

function persistPendingRound(
  database: SqliteDatabase,
  reviewId: string,
  roundId: string,
  fencingToken: string,
  timestamp: string,
  sessionID: string | null,
  lanes: string[],
): void {
  database.prepare(INSERT_LOCK_QUERY).run(reviewId, fencingToken, timestamp, sessionID ?? LEGACY_SESSION_ID)
  database.prepare(UPDATE_PENDING_ROUND_QUERY).run(roundId, reviewId, fencingToken)
  for (const lane of lanes) {
    database.prepare(INSERT_ROUND_LANE_QUERY).run(roundId, reviewId, lane, timestamp, timestamp)
  }
}

function completeReview(database: SqliteDatabase, request: CompleteReviewRequest): CompleteResult {
  const existingRound = database.prepare(EXISTING_ROUND_QUERY).get(request.roundId, request.reviewId) as ExistingRoundRow | undefined
  const activeLock = loadActiveLock(database, request, existingRound)
  const { laneRows, laneResults, payload } = loadLanePayload(database, request)
  const expectedIntent = loadExpectedIntent(database, request, existingRound, activeLock)
  validateRequiredLaneIntent(laneRows.map((row) => row.lane), expectedIntent, request.intent)
  const payloadHash = hashRoundPayload(laneRows.length === 0 ? payload : { ...payload, laneResults })
  if (existingRound) return completeRoundRetry(database, request, existingRound, payloadHash)
  const requestSessionID = validateNewRoundSession(activeLock, request)
  persistNewRound(database, request, payload, laneResults, payloadHash, requestSessionID)
  return { roundId: request.roundId, idempotent: false }
}

function loadActiveLock(database: SqliteDatabase, request: CompleteReviewRequest, existingRound: ExistingRoundRow | undefined): ActiveLockRow | undefined {
  if (existingRound) return undefined
  const activeLock = database.prepare(ACTIVE_LOCK_QUERY).get(request.reviewId) as ActiveLockRow | undefined
  if (!activeLock) throw new Error("review lock fencing token is stale or missing")
  const hasMatchingLock = activeLock.fencing_token === request.fencingToken
  if (!hasMatchingLock) throw new Error("review lock fencing token is stale or missing")
  const hasPendingRound = activeLock.pending_round_id !== null
  const pendingRoundMatches = activeLock.pending_round_id === request.roundId
  const isLegacyPending = !hasPendingRound && activeLock.lane_count === 0
  const pendingRoundMismatch = hasPendingRound && !pendingRoundMatches
  // A lane-aware lock without pending_round_id violates migration 003; legacy pre-003 locks have no lane rows.
  const unsupportedMissingPendingRound = !hasPendingRound && !isLegacyPending
  if (pendingRoundMismatch || unsupportedMissingPendingRound) throw new Error("review round does not match the active lock pending round")
  return activeLock
}

function loadLanePayload(database: SqliteDatabase, request: CompleteReviewRequest): {
  laneRows: LaneRow[]
  laneResults: LaneResult[]
  payload: NormalizedRoundPayload
} {
  const laneRows = database.prepare(ROUND_LANES_QUERY).all(request.roundId, request.reviewId) as LaneRow[]
  const laneResults = validateLaneResults(request.laneResults, laneRows)
  const payload = normalizeRoundPayload(request.validFindings, request.ignoredFindings, request.uncertainties)
  if (laneRows.length > 0) {
    const laneNames = laneRows.map((row) => row.lane)
    for (const finding of [...payload.validFindings, ...payload.ignoredFindings]) {
      validateFindingOwnership(finding.category, finding.sourceAgents, laneNames)
    }
  }
  return { laneRows, laneResults, payload }
}

function loadExpectedIntent(
  database: SqliteDatabase,
  request: CompleteReviewRequest,
  existingRound: ExistingRoundRow | undefined,
  activeLock: ActiveLockRow | undefined,
): ExpectedIntentRow | undefined {
  if (existingRound) {
    return database.prepare(ROUND_INTENT_QUERY).get(request.roundId, request.reviewId) as ExpectedIntentRow | undefined
  }
  if (!activeLock) return undefined
  return { intent_type: activeLock.current_intent_type, intent_ref: activeLock.current_intent_ref }
}

function completeRoundRetry(
  database: SqliteDatabase,
  request: CompleteReviewRequest,
  existingRound: ExistingRoundRow,
  payloadHash: string,
): CompleteResult {
  // Fencing is deliberately not checked here: the payload hash and completed session bind this round, while an active lock may belong to a newer round.
  if (existingRound.payload_hash !== payloadHash) throw new Error("round retry payload differs from the original")
  const requestSessionID = sessionValue(request.sessionID)
  const hasRequestSession = requestSessionID !== null
  const completedByDifferentSession = existingRound.completed_session_id !== null && existingRound.completed_session_id !== requestSessionID
  if (hasRequestSession && completedByDifferentSession) {
    throw new Error("review lock session ownership mismatch")
  }
  if (hasRequestSession && existingRound.completed_session_id === null) {
    database.prepare(UPDATE_COMPLETED_SESSION_QUERY).run(requestSessionID, request.roundId, request.reviewId)
  }
  if (requestSessionID) resolveMarkers(database, requestSessionID, request.reviewId, now())
  return { roundId: request.roundId, idempotent: true }
}

function validateNewRoundSession(activeLock: ActiveLockRow | undefined, request: CompleteReviewRequest): string | null {
  const requestSessionID = sessionValue(request.sessionID)
  const isLegacyLock = activeLock?.session_id === LEGACY_SESSION_ID
  const hasSessionMismatch = activeLock !== undefined && activeLock.session_id !== requestSessionID
  const requestHasSession = requestSessionID !== null
  const sessionMismatchWithBoundLock = requestHasSession && hasSessionMismatch
  const sessionMismatchRequiresRejection = sessionMismatchWithBoundLock && !isLegacyLock
  if (sessionMismatchRequiresRejection) throw new Error("review lock session ownership mismatch")
  return requestSessionID
}

function persistNewRound(
  database: SqliteDatabase,
  request: CompleteReviewRequest,
  payload: NormalizedRoundPayload,
  laneResults: LaneResult[],
  payloadHash: string,
  requestSessionID: string | null,
): void {
  const latest = database.prepare(LATEST_ROUND_QUERY).get(request.reviewId) as LatestRoundRow
  const ordinal = Number(latest.ordinal) + 1
  const [intentType, intentRef] = intentValues(request.intent)
  const completedAt = now()
  database.prepare(INSERT_ROUND_QUERY).run(
    request.roundId,
    request.reviewId,
    ordinal,
    payloadHash,
    intentType,
    intentRef,
    completedAt,
    requestSessionID,
  )
  for (const result of laneResults) {
    database.prepare(UPDATE_ROUND_LANE_QUERY).run(
      result.status,
      result.failureReason ?? null,
      completedAt,
      request.roundId,
      request.reviewId,
      result.lane,
    )
  }
  persistRoundContent(database, request.roundId, payload)
  database.prepare(DELETE_LOCK_QUERY).run(request.reviewId, request.fencingToken)
  if (requestSessionID) resolveMarkers(database, requestSessionID, request.reviewId, completedAt)
}

function persistRoundContent(database: SqliteDatabase, roundId: string, payload: NormalizedRoundPayload): void {
  const uncertaintyIds: number[] = []
  for (let index = 0; index < payload.uncertainties.length; index += 1) {
    const uncertainty = payload.uncertainties[index]
    const result = database.prepare(INSERT_UNCERTAINTY_QUERY).run(roundId, index + 1, uncertainty.title, uncertainty.observedEvidence, uncertainty.missingContext, uncertainty.clarificationQuestion)
    uncertaintyIds.push(Number(result.lastInsertRowid))
  }
  const findings = [...payload.validFindings, ...payload.ignoredFindings]
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index]
    const result = database.prepare(INSERT_FINDING_QUERY).run(roundId, index + 1, finding.disposition, finding.severity, finding.category, finding.title, finding.bodyMarkdown, finding.wontfix ?? null, JSON.stringify(finding.sourceAgents), finding.contentHash)
    persistFindingBlocks(database, Number(result.lastInsertRowid), finding.blockedByUncertaintyIds, uncertaintyIds)
  }
}

function persistFindingBlocks(database: SqliteDatabase, findingId: number, uncertaintyReferences: string[], uncertaintyIds: number[]): void {
  for (const uncertaintyId of uncertaintyReferences) {
    const numericId = Number(uncertaintyId)
    if (!Number.isInteger(numericId) || numericId < 1 || numericId > uncertaintyIds.length) throw new Error(`invalid uncertainty reference ${uncertaintyId}`)
    database.prepare(INSERT_FINDING_BLOCK_QUERY).run(findingId, uncertaintyIds[numericId - 1])
  }
}

function validateRequiredLaneIntent(
  lanes: string[],
  expected: { intent_type: string | null; intent_ref: string | null } | undefined,
  actual: CompleteReviewRequest["intent"],
): void {
  const requiresIntent = lanes.some((name) => laneByName(name)?.requiresIntent === true)
  if (!requiresIntent) return
  const [actualType, actualRef] = intentValues(actual)
  const matchesExpected = expected?.intent_type === actualType && expected.intent_ref === actualRef
  if (!matchesExpected) throw new Error("intent reference must match the reference established at review begin")
}

function validateLaneResults(requested: LaneResult[] | undefined, rows: Array<{ lane: string; status: "completed" | "failed" | null; failure_reason: string | null }>): LaneResult[] {
  if (rows.length === 0) {
    if (requested !== undefined) throw new Error("laneResults are not supported for legacy review rounds")
    return []
  }
  if (!requested) throw new Error("laneResults are required for this review round")
  if (requested.length !== rows.length) throw new Error("laneResults must account for every requested lane exactly once")
  const rowNames = new Set(rows.map((row) => row.lane))
  const resultNames = new Set<string>()
  for (const result of requested) {
    if (typeof result.lane !== "string" || !rowNames.has(result.lane)) throw new Error(`lane result ${result.lane} is not requested for this review round`)
    if (resultNames.has(result.lane)) throw new Error("laneResults must not contain duplicates")
    resultNames.add(result.lane)
    if (result.status !== "completed" && result.status !== "failed") throw new Error("lane result status is invalid")
  }
  if (resultNames.size !== rowNames.size) throw new Error("laneResults must account for every requested lane exactly once")
  return rows.map((row) => canonicalLaneResult(requested.find((result) => result.lane === row.lane) as LaneResult))
}

function canonicalLaneResult(result: LaneResult): LaneResult {
  const hasFailureReason = Object.hasOwn(result, "failureReason")
  if (result.status === "completed") {
    if (hasFailureReason) throw new Error("completed lane results must not include failureReason")
    return { lane: result.lane, status: result.status }
  }
  if (!hasFailureReason) return { lane: result.lane, status: result.status }
  const failureReason = normalizeFailureReason(result.failureReason)
  return { lane: result.lane, status: result.status, failureReason }
}

function normalizeFailureReason(value: unknown): string {
  if (typeof value !== "string") throw new Error("failureReason must be a non-empty string")
  const normalized = value.trim().replace(/\s+/g, " ")
  if (!normalized) throw new Error("failureReason must be a non-empty string")
  return normalized
}
