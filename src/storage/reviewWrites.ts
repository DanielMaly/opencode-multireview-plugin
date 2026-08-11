import { randomUUID } from "node:crypto"
import type { DatabaseOptions } from "./database.js"
import { withDatabase } from "./database.js"
import {
  hashRoundPayload,
  normalizeRoundPayload,
} from "../findings.js"
import { newReviewId } from "../repository.js"
import { intentValues, LEGACY_SESSION_ID, sessionValue, type BeginReviewRequest, type BeginReviewResult, type CompleteReviewRequest } from "../review.js"
import { previousIgnored } from "./reviewReads.js"
import { resolveMarkers } from "./reviewLifecycle.js"

function now(): string {
  return new Date().toISOString()
}

export function begin(options: DatabaseOptions, request: BeginReviewRequest): BeginReviewResult {
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
        database.exec("COMMIT")
        return { reviewId: existing.id, locked: true, acquiredAt: lock.acquired_at, previousIgnored: [] }
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
      const previousRows = previousIgnored(database, stableReviewId)
      const fencingToken = randomUUID()
      const sessionID = sessionValue(request.sessionID)
      database.prepare("INSERT INTO review_locks (review_id, fencing_token, acquired_at, session_id) VALUES (?, ?, ?, ?)").run(
        stableReviewId,
        fencingToken,
        timestamp,
        sessionID ?? LEGACY_SESSION_ID,
      )
      database.exec("COMMIT")
      return {
        reviewId: stableReviewId,
        roundId: randomUUID(),
        fencingToken,
        acquiredAt: timestamp,
        locked: false,
        previousIgnored: previousRows,
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
      const payload = normalizeRoundPayload(request.validFindings, request.ignoredFindings, request.uncertainties)
      const payloadHash = hashRoundPayload(payload)
      const existingRound = database.prepare("SELECT payload_hash, completed_session_id FROM review_rounds WHERE id = ? AND review_id = ?").get(request.roundId, request.reviewId) as {
        payload_hash: string
        completed_session_id: string | null
      } | undefined
      if (existingRound) {
        if (existingRound.payload_hash !== payloadHash) throw new Error("round retry payload differs from the original")
        const requestSessionID = sessionValue(request.sessionID)
        if (requestSessionID && existingRound.completed_session_id !== null && existingRound.completed_session_id !== requestSessionID) {
          throw new Error("review lock session ownership mismatch")
        }
        const activeLock = database.prepare("SELECT fencing_token, session_id FROM review_locks WHERE review_id = ?").get(request.reviewId) as {
          fencing_token: string
          session_id: string
        } | undefined
        if (activeLock && activeLock.fencing_token !== request.fencingToken) throw new Error("review lock fencing token is stale or missing")
        const requestHasSession = requestSessionID !== null
        const activeLockHasSessionMismatch = activeLock !== undefined && activeLock.session_id !== requestSessionID
        const activeLockIsLegacy = activeLock?.session_id === LEGACY_SESSION_ID
        if (requestHasSession && activeLockHasSessionMismatch) {
          if (!activeLockIsLegacy) throw new Error("review lock session ownership mismatch")
        }
        if (requestSessionID && existingRound.completed_session_id === null) {
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
      const lock = database.prepare("SELECT fencing_token, session_id FROM review_locks WHERE review_id = ?").get(request.reviewId) as {
        fencing_token: string
        session_id: string
      } | undefined
      if (!lock || lock.fencing_token !== request.fencingToken) throw new Error("review lock fencing token is stale or missing")
      const requestSessionID = sessionValue(request.sessionID)
      const isLegacyLock = lock.session_id === LEGACY_SESSION_ID
      if (requestSessionID && !isLegacyLock && lock.session_id !== requestSessionID) throw new Error("review lock session ownership mismatch")
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
