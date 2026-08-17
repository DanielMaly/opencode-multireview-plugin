import { randomUUID } from "node:crypto"
import type { DatabaseOptions } from "./database.js"
import { withDatabase } from "./database.js"
import {
  hashRoundPayload,
  normalizeRoundPayload,
} from "../findings.js"
import { newReviewId } from "../repository.js"
import { intentValues, LEGACY_SESSION_ID, sessionValue, type BeginReviewRequest, type BeginReviewResult, type CompleteReviewRequest, type SetFindingDispositionRequest, type SetFindingDispositionResult } from "../review.js"
import type { FindingDisposition } from "../findings.js"
import { previousIgnored } from "./reviewReads.js"
import { activeLaneSnapshot, resolveMarkers } from "./reviewLifecycle.js"
import { laneByName, normalizeLanes, validateFindingOwnership } from "../lanes.js"
import type { LaneResult } from "../review.js"

const FINDING_DISPOSITION_LOOKUP_SQL = `
  SELECT
    f.id AS finding_id,
    f.round_id,
    rr.review_id,
    rr.ordinal AS round_ordinal,
    (
      SELECT MAX(latest.ordinal)
      FROM review_rounds latest
      WHERE latest.review_id = rr.review_id
    ) AS latest_round_ordinal,
    r.target_kind,
    p.project_key,
    w.path AS worktree_path,
    f.disposition AS original_disposition,
    f.wontfix AS original_wontfix,
    o.disposition AS current_disposition,
    o.reason AS current_reason
  FROM findings f
  JOIN review_rounds rr ON rr.id = f.round_id
  JOIN reviews r ON r.id = rr.review_id
  JOIN projects p ON p.id = r.project_id
  JOIN worktrees w ON w.id = r.worktree_id
  LEFT JOIN finding_disposition_overrides o ON o.finding_id = f.id
  WHERE f.id = ?
`
const ACTIVE_REVIEW_LOCK_SQL = "SELECT 1 AS active FROM review_locks WHERE review_id = ?"
const DELETE_FINDING_DISPOSITION_OVERRIDE_SQL = "DELETE FROM finding_disposition_overrides WHERE finding_id = ?"
const UPSERT_FINDING_DISPOSITION_OVERRIDE_SQL = "INSERT INTO finding_disposition_overrides (finding_id, disposition, reason, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(finding_id) DO UPDATE SET disposition = excluded.disposition, reason = excluded.reason, updated_at = excluded.updated_at"

function now(): string {
  return new Date().toISOString()
}

export function begin(options: DatabaseOptions, request: BeginReviewRequest): BeginReviewResult {
  const lanes = normalizeLanes(request.lanes, request.intent !== undefined && request.intent !== null)
  return withDatabase(options, (database) => {
    database.exec("BEGIN IMMEDIATE")
    try {
      const timestamp = now()
      const identity = request.identity
      const project = database.prepare("SELECT id FROM projects WHERE project_key = ?").get(identity.projectKey) as { id: number } | undefined
      const existing = project
        ? database.prepare("SELECT id, target_kind FROM reviews WHERE project_id = ? AND target_key = ? AND base_commit = ?").get(project.id, request.target.key, identity.baseCommit) as { id: string; target_kind: string } | undefined
        : undefined
      if (existing && existing.target_kind !== request.target.kind) throw new Error("review target kind does not match existing review identity")
      const stableReviewId = existing?.id ?? newReviewId()
      const lock = existing
        ? database.prepare("SELECT fencing_token, acquired_at FROM review_locks WHERE review_id = ?").get(existing.id) as { fencing_token: string; acquired_at: string } | undefined
        : undefined
      if (existing && lock) {
        const activeLanes = activeLaneSnapshot(database, existing.id)
        database.exec("COMMIT")
        return { reviewId: existing.id, locked: true, acquiredAt: lock.acquired_at, previousIgnored: [], lanes: activeLanes.lanes }
      }
      let projectId: number
      if (project) {
        projectId = project.id
        database.prepare("UPDATE projects SET root_path = ?, git_common_dir = ?, origin_url = ?, last_seen_at = ? WHERE id = ?").run(
          identity.rootPath,
          identity.gitCommonDir ?? null,
          identity.originUrl ?? null,
          timestamp,
          projectId,
        )
      } else {
        const result = database.prepare("INSERT INTO projects (project_key, root_path, git_common_dir, origin_url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)").run(
          identity.projectKey,
          identity.rootPath,
          identity.gitCommonDir ?? null,
          identity.originUrl ?? null,
          timestamp,
          timestamp,
        )
        projectId = Number(result.lastInsertRowid)
      }
      const worktree = database.prepare("SELECT id FROM worktrees WHERE project_id = ? AND path = ?").get(projectId, identity.worktreePath) as { id: number } | undefined
      let worktreeId: number
      if (worktree) {
        worktreeId = worktree.id
        database.prepare("UPDATE worktrees SET last_seen_at = ? WHERE id = ?").run(timestamp, worktreeId)
      } else {
        const result = database.prepare("INSERT INTO worktrees (project_id, path, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)").run(projectId, identity.worktreePath, timestamp, timestamp)
        worktreeId = Number(result.lastInsertRowid)
      }
      const [intentType, intentRef] = intentValues(request.intent)
      if (existing) {
        database.prepare("UPDATE reviews SET worktree_id = ?, target_kind = ?, target_label = ?, base_ref = ?, branch = ?, head_commit = ?, pr_provider = ?, pr_repository = ?, pr_number = ?, updated_at = ? WHERE id = ?").run(
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
          stableReviewId,
        )
      } else {
        database.prepare("INSERT INTO reviews (id, project_id, worktree_id, target_kind, target_key, target_label, base_ref, base_commit, branch, head_commit, pr_provider, pr_repository, pr_number, current_intent_type, current_intent_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          stableReviewId,
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
      database.prepare("UPDATE reviews SET current_intent_type = ?, current_intent_ref = ?, updated_at = ? WHERE id = ?").run(intentType, intentRef, timestamp, stableReviewId)
      const previousRows = previousIgnored(database, stableReviewId, lanes)
      const fencingToken = randomUUID()
      const roundId = randomUUID()
      const sessionID = sessionValue(request.sessionID)
      database.prepare("INSERT INTO review_locks (review_id, fencing_token, acquired_at, session_id) VALUES (?, ?, ?, ?)").run(
        stableReviewId,
        fencingToken,
        timestamp,
        sessionID ?? LEGACY_SESSION_ID,
      )
      database.prepare("UPDATE review_locks SET pending_round_id = ? WHERE review_id = ? AND fencing_token = ?").run(roundId, stableReviewId, fencingToken)
      for (const lane of lanes) {
        database.prepare("INSERT INTO review_round_lanes (round_id, review_id, lane, status, failure_reason, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)").run(
          roundId,
          stableReviewId,
          lane,
          timestamp,
          timestamp,
        )
      }
      database.exec("COMMIT")
      return {
        reviewId: stableReviewId,
        roundId,
        fencingToken,
        acquiredAt: timestamp,
        locked: false,
        previousIgnored: previousRows,
        lanes,
      }
    } catch (error) {
      try { database.exec("ROLLBACK") } catch { /* retain original error */ }
      throw error
    }
  })
}

export function complete(options: DatabaseOptions, request: CompleteReviewRequest): { roundId: string; idempotent: boolean } {
  return withDatabase(options, (database) => {
    database.exec("BEGIN IMMEDIATE")
    try {
      const existingRound = database.prepare("SELECT payload_hash, completed_session_id FROM review_rounds WHERE id = ? AND review_id = ?").get(request.roundId, request.reviewId) as {
        payload_hash: string
        completed_session_id: string | null
      } | undefined
      let activeLock: {
        fencing_token: string
        pending_round_id: string | null
        session_id: string
        current_intent_type: string | null
        current_intent_ref: string | null
        lane_count: number
      } | undefined
      if (!existingRound) {
        activeLock = database.prepare("SELECT l.fencing_token, l.pending_round_id, l.session_id, r.current_intent_type, r.current_intent_ref, (SELECT COUNT(*) FROM review_round_lanes WHERE review_id = l.review_id) AS lane_count FROM review_locks l JOIN reviews r ON r.id = l.review_id WHERE l.review_id = ?").get(request.reviewId) as typeof activeLock
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
      }
      const laneRows = database.prepare("SELECT lane, status, failure_reason FROM review_round_lanes WHERE round_id = ? AND review_id = ? ORDER BY lane").all(request.roundId, request.reviewId) as Array<{
        lane: string
        status: "completed" | "failed" | null
        failure_reason: string | null
      }>
      const laneResults = validateLaneResults(request.laneResults, laneRows)
      const payload = normalizeRoundPayload(request.validFindings, request.ignoredFindings, request.uncertainties)
      if (laneRows.length > 0) {
        for (const finding of [...payload.validFindings, ...payload.ignoredFindings]) {
          validateFindingOwnership(finding.category, finding.sourceAgents, laneRows.map((row) => row.lane))
        }
      }
      let expectedIntent: { intent_type: string | null; intent_ref: string | null } | undefined
      if (existingRound) {
        expectedIntent = database.prepare("SELECT intent_type, intent_ref FROM review_rounds WHERE id = ? AND review_id = ?").get(request.roundId, request.reviewId) as typeof expectedIntent
      } else if (activeLock) {
        expectedIntent = { intent_type: activeLock.current_intent_type, intent_ref: activeLock.current_intent_ref }
      }
      validateRequiredLaneIntent(laneRows.map((row) => row.lane), expectedIntent, request.intent)
      const payloadHash = hashRoundPayload(laneRows.length === 0 ? payload : { ...payload, laneResults })
      if (existingRound) {
        // Fencing is deliberately not checked here: the payload hash and completed session bind this round, while an active lock may belong to a newer round.
        if (existingRound.payload_hash !== payloadHash) throw new Error("round retry payload differs from the original")
        const requestSessionID = sessionValue(request.sessionID)
        const hasRequestSession = requestSessionID !== null
        const completedByDifferentSession = existingRound.completed_session_id !== null && existingRound.completed_session_id !== requestSessionID
        if (hasRequestSession && completedByDifferentSession) {
          throw new Error("review lock session ownership mismatch")
        }
        if (hasRequestSession && existingRound.completed_session_id === null) {
          database.prepare("UPDATE review_rounds SET completed_session_id = ? WHERE id = ? AND review_id = ? AND completed_session_id IS NULL").run(
            requestSessionID,
            request.roundId,
            request.reviewId,
          )
        }
        if (requestSessionID) resolveMarkers(database, requestSessionID, request.reviewId, now())
        database.exec("COMMIT")
        return { roundId: request.roundId, idempotent: true }
      }
      const requestSessionID = sessionValue(request.sessionID)
      const isLegacyLock = activeLock?.session_id === LEGACY_SESSION_ID
      const hasSessionMismatch = activeLock !== undefined && activeLock.session_id !== requestSessionID
      const requestHasSession = requestSessionID !== null
      const sessionMismatchWithBoundLock = requestHasSession && hasSessionMismatch
      const sessionMismatchRequiresRejection = sessionMismatchWithBoundLock && !isLegacyLock
      if (sessionMismatchRequiresRejection) throw new Error("review lock session ownership mismatch")
      const latest = database.prepare("SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM review_rounds WHERE review_id = ?").get(request.reviewId) as { ordinal: number }
      const ordinal = Number(latest.ordinal) + 1
      const [intentType, intentRef] = intentValues(request.intent)
      const completedAt = now()
      database.prepare("INSERT INTO review_rounds (id, review_id, ordinal, payload_hash, intent_type, intent_ref, completed_at, completed_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
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
        database.prepare("UPDATE review_round_lanes SET status = ?, failure_reason = ?, updated_at = ? WHERE round_id = ? AND review_id = ? AND lane = ?").run(
          result.status,
          result.failureReason ?? null,
          completedAt,
          request.roundId,
          request.reviewId,
          result.lane,
        )
      }
      const uncertaintyIds: number[] = []
      for (let index = 0; index < payload.uncertainties.length; index += 1) {
        const uncertainty = payload.uncertainties[index]
        const result = database.prepare("INSERT INTO intent_uncertainties (round_id, ordinal, title, observed_evidence, missing_context, clarification_question) VALUES (?, ?, ?, ?, ?, ?)").run(request.roundId, index + 1, uncertainty.title, uncertainty.observedEvidence, uncertainty.missingContext, uncertainty.clarificationQuestion)
        uncertaintyIds.push(Number(result.lastInsertRowid))
      }
      const findings = [...payload.validFindings, ...payload.ignoredFindings]
      for (let index = 0; index < findings.length; index += 1) {
        const finding = findings[index]
        const result = database.prepare("INSERT INTO findings (round_id, ordinal, disposition, severity, category, title, body_markdown, wontfix, source_agents_json, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(request.roundId, index + 1, finding.disposition, finding.severity, finding.category, finding.title, finding.bodyMarkdown, finding.wontfix ?? null, JSON.stringify(finding.sourceAgents), finding.contentHash)
        for (const uncertaintyId of finding.blockedByUncertaintyIds) {
          const numericId = Number(uncertaintyId)
          if (!Number.isInteger(numericId) || numericId < 1 || numericId > uncertaintyIds.length) throw new Error(`invalid uncertainty reference ${uncertaintyId}`)
          database.prepare("INSERT INTO finding_intent_blocks (finding_id, uncertainty_id) VALUES (?, ?)").run(Number(result.lastInsertRowid), uncertaintyIds[numericId - 1])
        }
      }
      database.prepare("DELETE FROM review_locks WHERE review_id = ? AND fencing_token = ?").run(request.reviewId, request.fencingToken)
      if (requestSessionID) resolveMarkers(database, requestSessionID, request.reviewId, completedAt)
      database.exec("COMMIT")
      return { roundId: request.roundId, idempotent: false }
    } catch (error) {
      try { database.exec("ROLLBACK") } catch { /* retain original error */ }
      throw error
    }
  })
}

type DispositionRow = {
  finding_id: number
  round_id: string
  review_id: string
  round_ordinal: number
  latest_round_ordinal: number
  target_kind: string
  project_key: string
  worktree_path: string
  original_disposition: FindingDisposition
  original_wontfix: string | null
  current_disposition: FindingDisposition | null
  current_reason: string | null
}

type DispositionResultOptions = {
  overridden: boolean
  idempotent: boolean
}

export function setFindingDisposition(options: DatabaseOptions, request: SetFindingDispositionRequest): SetFindingDispositionResult {
  return withDatabase(options, (database) => {
    database.exec("BEGIN IMMEDIATE")
    try {
      validateFindingId(request.findingId)
      const row = database.prepare(FINDING_DISPOSITION_LOOKUP_SQL).get(request.findingId) as DispositionRow | undefined
      if (!row) {
        if (request.scope) throw new Error("finding is outside the trusted project scope")
        throw new Error(`unknown finding ${request.findingId}`)
      }
      if (request.scope) validateDispositionScope(row, request.scope)
      if (Number(row.round_ordinal) !== Number(row.latest_round_ordinal)) throw new Error("finding is not in the latest completed round")
      if (database.prepare(ACTIVE_REVIEW_LOCK_SQL).get(row.review_id)) throw new Error("finding review has an active lock")
      const reason = validateDispositionRequest(request.disposition, request.reason)
      const originalMatches = dispositionMatches(row.original_disposition, row.original_wontfix, request.disposition, reason)
      const currentDisposition = row.current_disposition ?? row.original_disposition
      const currentReason = row.current_disposition === null ? row.original_wontfix : row.current_reason
      const currentMatches = dispositionMatches(currentDisposition, currentReason, request.disposition, reason)
      if (currentMatches) {
        database.exec("COMMIT")
        return dispositionResult(row, request.disposition, reason, { overridden: row.current_disposition !== null, idempotent: true })
      }
      if (originalMatches) {
        database.prepare(DELETE_FINDING_DISPOSITION_OVERRIDE_SQL).run(request.findingId)
      } else {
        database.prepare(UPSERT_FINDING_DISPOSITION_OVERRIDE_SQL).run(
          request.findingId,
          request.disposition,
          reason,
          now(),
        )
      }
      database.exec("COMMIT")
      return dispositionResult(row, request.disposition, reason, { overridden: !originalMatches, idempotent: false })
    } catch (error) {
      try { database.exec("ROLLBACK") } catch { /* retain original error */ }
      throw error
    }
  })
}

function validateFindingId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("findingId must be a positive integer")
}

function validateDispositionRequest(disposition: FindingDisposition, rawReason: string | undefined): string | null {
  if (disposition === "valid") {
    if (rawReason !== undefined) throw new Error("valid disposition cannot include reason")
    return null
  }
  if (typeof rawReason !== "string") throw new Error("ignored disposition requires a non-empty reason")
  const reason = rawReason.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim()
  if (!reason) throw new Error("ignored disposition requires a non-empty reason")
  return reason
}

function dispositionMatches(
  candidateDisposition: FindingDisposition,
  candidateReason: string | null,
  requestedDisposition: FindingDisposition,
  requestedReason: string | null,
): boolean {
  if (candidateDisposition !== requestedDisposition) return false
  return requestedDisposition === "valid" || candidateReason === requestedReason
}

function validateDispositionScope(row: DispositionRow, scope: NonNullable<SetFindingDispositionRequest["scope"]>): void {
  if (row.project_key !== scope.projectKey) throw new Error("finding is outside the trusted project scope")
  if (row.target_kind === "uncommitted" && row.worktree_path !== scope.worktreePath) {
    throw new Error("uncommitted finding is outside the trusted worktree scope")
  }
}

function dispositionResult(row: DispositionRow, disposition: FindingDisposition, reason: string | null, options: DispositionResultOptions): SetFindingDispositionResult {
  return {
    reviewId: row.review_id,
    roundId: row.round_id,
    findingId: Number(row.finding_id),
    disposition,
    ...(disposition === "ignored" ? { wontfix: reason as string } : {}),
    originalDisposition: row.original_disposition,
    ...(row.original_disposition === "ignored" && row.original_wontfix !== null ? { originalWontfix: row.original_wontfix } : {}),
    overridden: options.overridden,
    idempotent: options.idempotent,
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
