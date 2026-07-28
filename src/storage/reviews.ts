import { randomUUID } from "node:crypto"
import type { DatabaseOptions, SqliteDatabase } from "./database.js"
import { withDatabase } from "./database.js"
import {
  normalizeRoundPayload,
  type FindingInput,
  type IntentUncertainty,
  type NormalizedFinding,
  type NormalizedRoundPayload,
  hashRoundPayload,
} from "../findings.js"
import { newReviewId, type NormalizedTarget, type ResolvedReviewIdentity } from "../repository.js"

export interface IntentReference {
  type: "jira" | "local_file"
  ref: string
}

export interface BeginReviewRequest {
  identity: ResolvedReviewIdentity
  target: NormalizedTarget
  intent?: IntentReference | null
  sessionID?: string
}

export interface IgnoredSnapshot extends NormalizedFinding {
  id: number
}

export type BeginReviewResult = {
  reviewId: string
  locked: false
  roundId: string
  fencingToken: string
  acquiredAt: string
  previousIgnored: IgnoredSnapshot[]
} | {
  reviewId: string
  locked: true
  acquiredAt: string
  previousIgnored: []
}

export type ReviewScope = Pick<ResolvedReviewIdentity, "projectKey" | "worktreePath">

export interface CompleteReviewRequest {
  reviewId: string
  roundId: string
  fencingToken: string
  sessionID?: string
  intent?: IntentReference | null
  validFindings?: FindingInput[]
  ignoredFindings?: FindingInput[]
  uncertainties?: IntentUncertainty[]
}

export interface ReviewSummary {
  id: string
  targetKind: string
  targetKey: string
  targetLabel: string
  baseRef: string
  baseCommit: string
  currentIntentType?: string
  currentIntentRef?: string
  latestRoundId?: string
  latestRoundAt?: string
  lock?: { fencingToken: string; acquiredAt: string }
}

export interface LockInfo {
  reviewId: string
  fencingToken: string
  acquiredAt: string
  sessionID?: string
}

export type IncompleteDiagnosticEvent = "session.error"

export interface IncompleteDiagnosticMarkerRequest {
  sessionID: string
  reviewId: string
  event: IncompleteDiagnosticEvent
  markerKey?: string
}

export interface IncompleteDiagnosticMarkerResult {
  markerId: number
  deduplicated: boolean
}

export interface ReviewRound {
  id: string
  reviewId: string
  ordinal: number
  payloadHash: string
  intent?: IntentReference
  completedAt: string
  validFindings: NormalizedFinding[]
  ignoredFindings: IgnoredSnapshot[]
  uncertainties: IntentUncertainty[]
}

function now(): string {
  return new Date().toISOString()
}

function sessionValue(sessionID: string | undefined): string | null {
  const value = sessionID?.trim() || null
  return value === "__legacy_unbound__" ? null : value
}

function intentValues(intent: IntentReference | null | undefined): [string | null, string | null] {
  return intent ? [intent.type, intent.ref] : [null, null]
}

function rowFinding(row: Record<string, unknown>): NormalizedFinding {
  return {
    disposition: row.disposition as "valid" | "ignored",
    severity: row.severity as NormalizedFinding["severity"],
    category: row.category as NormalizedFinding["category"],
    title: row.title as string,
    bodyMarkdown: row.body_markdown as string,
    ...(row.wontfix === null ? {} : { wontfix: row.wontfix as string }),
    sourceAgents: JSON.parse(row.source_agents_json as string) as string[],
    blockedByUncertaintyIds: [],
    contentHash: row.content_hash as string,
  }
}

export class ReviewStore {
  constructor(private readonly options: DatabaseOptions = {}) {}

  begin(request: BeginReviewRequest): BeginReviewResult {
    return withDatabase(this.options, (database) => {
      database.exec("BEGIN IMMEDIATE")
      try {
        const timestamp = now()
        const identity = request.identity
        const project = database.prepare("SELECT id FROM projects WHERE project_key = ?").get(identity.projectKey) as { id: number } | undefined
        const existing = project
          ? database.prepare("SELECT id FROM reviews WHERE project_id = ? AND target_key = ? AND base_commit = ?").get(project.id, request.target.key, identity.baseCommit) as { id: string } | undefined
          : undefined
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
        const previousRows = database.prepare("SELECT id, disposition, severity, category, title, body_markdown, wontfix, source_agents_json, content_hash FROM findings WHERE round_id = (SELECT id FROM review_rounds WHERE review_id = ? ORDER BY ordinal DESC LIMIT 1) AND disposition = 'ignored' ORDER BY ordinal").all(stableReviewId) as Array<Record<string, unknown>>
        const fencingToken = randomUUID()
        const sessionID = sessionValue(request.sessionID)
        database.prepare("INSERT INTO review_locks (review_id, fencing_token, acquired_at, session_id) VALUES (?, ?, ?, ?)").run(
          stableReviewId,
          fencingToken,
          timestamp,
          sessionID ?? "__legacy_unbound__",
        )
        database.exec("COMMIT")
        return {
          reviewId: stableReviewId,
          roundId: randomUUID(),
          fencingToken,
          acquiredAt: timestamp,
          locked: false,
          previousIgnored: previousRows.map((row) => ({ id: Number(row.id), ...rowFinding(row) })),
        }
      } catch (error) {
        try { database.exec("ROLLBACK") } catch { /* retain original error */ }
        throw error
      }
    })
  }

  assertReviewScope(reviewId: string, scope: ReviewScope): void {
    withDatabase(this.options, (database) => {
      const row = database.prepare("SELECT p.project_key, r.target_kind, w.path FROM reviews r JOIN projects p ON p.id = r.project_id JOIN worktrees w ON w.id = r.worktree_id WHERE r.id = ?").get(reviewId) as {
        project_key: string
        target_kind: string
        path: string
      } | undefined
      if (!row || row.project_key !== scope.projectKey) throw new Error("review is outside the trusted project scope")
      if (row.target_kind === "uncommitted" && row.path !== scope.worktreePath) {
        throw new Error("uncommitted review is outside the trusted worktree scope")
      }
    })
  }

  complete(request: CompleteReviewRequest): { roundId: string; idempotent: boolean } {
    return withDatabase(this.options, (database) => {
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
          if (requestSessionID && activeLock && activeLock.session_id !== "__legacy_unbound__" && activeLock.session_id !== requestSessionID) {
            throw new Error("review lock session ownership mismatch")
          }
          if (requestSessionID && existingRound.completed_session_id === null) {
            database.prepare("UPDATE review_rounds SET completed_session_id = ? WHERE id = ? AND review_id = ? AND completed_session_id IS NULL").run(
              requestSessionID,
              request.roundId,
              request.reviewId,
            )
          }
          if (requestSessionID) this.resolveMarkers(database, requestSessionID, request.reviewId, now())
          database.exec("COMMIT")
          return { roundId: request.roundId, idempotent: true }
        }
        const lock = database.prepare("SELECT fencing_token, session_id FROM review_locks WHERE review_id = ?").get(request.reviewId) as {
          fencing_token: string
          session_id: string
        } | undefined
        if (!lock || lock.fencing_token !== request.fencingToken) throw new Error("review lock fencing token is stale or missing")
        const requestSessionID = sessionValue(request.sessionID)
        const isLegacyLock = lock.session_id === "__legacy_unbound__"
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
        if (requestSessionID) this.resolveMarkers(database, requestSessionID, request.reviewId, completedAt)
        database.exec("COMMIT")
        return { roundId: request.roundId, idempotent: false }
      } catch (error) {
        try { database.exec("ROLLBACK") } catch { /* retain original error */ }
        throw error
      }
    })
  }

  list(projectKey?: string): ReviewSummary[] {
    return withDatabase(this.options, (database) => database.prepare("SELECT r.id, r.target_kind, r.target_key, r.target_label, r.base_ref, r.base_commit, r.current_intent_type, r.current_intent_ref, rr.id AS latest_round_id, rr.completed_at AS latest_round_at, rl.fencing_token, rl.acquired_at FROM reviews r LEFT JOIN review_rounds rr ON rr.review_id = r.id AND rr.ordinal = (SELECT MAX(ordinal) FROM review_rounds WHERE review_id = r.id) LEFT JOIN review_locks rl ON rl.review_id = r.id WHERE (? IS NULL OR r.project_id = (SELECT id FROM projects WHERE project_key = ?)) ORDER BY r.project_id, r.target_kind, r.target_key, r.base_commit").all(projectKey ?? null, projectKey ?? null).map((row) => {
      const value = row as Record<string, unknown>
      return {
        id: value.id as string,
        targetKind: value.target_kind as string,
        targetKey: value.target_key as string,
        targetLabel: value.target_label as string,
        baseRef: value.base_ref as string,
        baseCommit: value.base_commit as string,
        ...(value.current_intent_type === null ? {} : { currentIntentType: value.current_intent_type as string, currentIntentRef: value.current_intent_ref as string }),
        ...(value.latest_round_id === null ? {} : { latestRoundId: value.latest_round_id as string, latestRoundAt: value.latest_round_at as string }),
        ...(value.fencing_token === null ? {} : { lock: { fencingToken: value.fencing_token as string, acquiredAt: value.acquired_at as string } }),
      }
    }))
  }

  listRounds(reviewId: string): ReviewRound[] {
    return withDatabase(this.options, (database) => {
      const rounds = database.prepare("SELECT id, review_id, ordinal, payload_hash, intent_type, intent_ref, completed_at FROM review_rounds WHERE review_id = ? ORDER BY ordinal").all(reviewId) as Array<Record<string, unknown>>
      return rounds.map((round) => this.readRound(database, round))
    })
  }

  getRound(reviewId: string, roundId?: string): ReviewRound | undefined {
    return withDatabase(this.options, (database) => {
      const row = roundId === undefined
        ? database.prepare("SELECT id, review_id, ordinal, payload_hash, intent_type, intent_ref, completed_at FROM review_rounds WHERE review_id = ? ORDER BY ordinal DESC LIMIT 1").get(reviewId)
        : database.prepare("SELECT id, review_id, ordinal, payload_hash, intent_type, intent_ref, completed_at FROM review_rounds WHERE review_id = ? AND id = ?").get(reviewId, roundId)
      return row ? this.readRound(database, row as Record<string, unknown>) : undefined
    })
  }

  inspectLock(reviewId: string): LockInfo | undefined {
    return withDatabase(this.options, (database) => {
      const row = database.prepare("SELECT review_id, fencing_token, acquired_at, session_id FROM review_locks WHERE review_id = ?").get(reviewId) as Record<string, unknown> | undefined
      return row ? {
        reviewId: row.review_id as string,
        fencingToken: row.fencing_token as string,
        acquiredAt: row.acquired_at as string,
        ...(row.session_id === "__legacy_unbound__" ? {} : { sessionID: row.session_id as string }),
      } : undefined
    })
  }

  hasActiveLockOwnedBySession(sessionID: string, reviewId?: string): boolean {
    const owner = sessionValue(sessionID)
    if (!owner) return false
    return withDatabase(this.options, (database) => {
      const row = reviewId === undefined
        ? database.prepare("SELECT 1 AS present FROM review_locks WHERE session_id = ? LIMIT 1").get(owner)
        : database.prepare("SELECT 1 AS present FROM review_locks WHERE review_id = ? AND session_id = ?").get(reviewId, owner)
      return row !== undefined
    })
  }

  activeReviewForSession(sessionID: string): { reviewId: string } | undefined {
    const owner = sessionValue(sessionID)
    if (!owner) return undefined
    return withDatabase(this.options, (database) => {
      const row = database.prepare("SELECT review_id FROM review_locks WHERE session_id = ? LIMIT 1").get(owner) as { review_id: string } | undefined
      return row ? { reviewId: row.review_id } : undefined
    })
  }

  recordIncompleteDiagnosticMarker(request: IncompleteDiagnosticMarkerRequest): IncompleteDiagnosticMarkerResult {
    const sessionID = sessionValue(request.sessionID)
    if (!sessionID) throw new Error("sessionID must be a non-empty string")
    const markerKey = request.markerKey?.trim() || request.event
    return withDatabase(this.options, (database) => {
      database.exec("BEGIN IMMEDIATE")
      try {
        const existing = database.prepare("SELECT id, status FROM review_lifecycle_markers WHERE session_id = ? AND review_id = ? AND event = ? AND marker_key = ?").get(
          sessionID,
          request.reviewId,
          request.event,
          markerKey,
        ) as { id: number; status: "open" | "resolved" } | undefined
        if (existing?.status === "open") {
          database.exec("COMMIT")
          return { markerId: Number(existing.id), deduplicated: true }
        }
        const timestamp = now()
        if (existing) {
          database.prepare("UPDATE review_lifecycle_markers SET status = 'open', updated_at = ? WHERE id = ?").run(timestamp, existing.id)
          database.exec("COMMIT")
          return { markerId: Number(existing.id), deduplicated: false }
        }
        const result = database.prepare("INSERT INTO review_lifecycle_markers (session_id, review_id, event, marker_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)").run(
          sessionID,
          request.reviewId,
          request.event,
          markerKey,
          timestamp,
          timestamp,
        )
        database.exec("COMMIT")
        return { markerId: Number(result.lastInsertRowid), deduplicated: false }
      } catch (error) {
        try { database.exec("ROLLBACK") } catch { /* retain original error */ }
        throw error
      }
    })
  }

  releaseIncompleteDiagnosticMarker(request: IncompleteDiagnosticMarkerRequest): boolean {
    const owner = sessionValue(request.sessionID)
    if (!owner) return false
    const markerKey = request.markerKey?.trim() || request.event
    return withDatabase(this.options, (database) => {
      return database.prepare("DELETE FROM review_lifecycle_markers WHERE session_id = ? AND review_id = ? AND event = ? AND marker_key = ? AND status = 'open'").run(
        owner,
        request.reviewId,
        request.event,
        markerKey,
      ).changes > 0
    })
  }

  private resolveMarkers(database: SqliteDatabase, sessionID: string, reviewId: string, timestamp: string): void {
    database.prepare("UPDATE review_lifecycle_markers SET status = 'resolved', updated_at = ? WHERE session_id = ? AND review_id = ? AND status = 'open'").run(timestamp, sessionID, reviewId)
  }

  unlock(reviewId: string, fencingToken: string): boolean {
    return withDatabase(this.options, (database) => database.prepare("DELETE FROM review_locks WHERE review_id = ? AND fencing_token = ?").run(reviewId, fencingToken).changes > 0)
  }

  private readRound(database: SqliteDatabase, row: Record<string, unknown>): ReviewRound {
    const roundId = row.id as string
    const findings = database.prepare("SELECT id, disposition, severity, category, title, body_markdown, wontfix, source_agents_json, content_hash FROM findings WHERE round_id = ? ORDER BY disposition, ordinal").all(roundId) as Array<Record<string, unknown>>
    const uncertainties = database.prepare("SELECT id, ordinal, title, observed_evidence, missing_context, clarification_question FROM intent_uncertainties WHERE round_id = ? ORDER BY ordinal").all(roundId) as Array<Record<string, unknown>>
    const uncertaintyIds = new Map(uncertainties.map((uncertainty) => [Number(uncertainty.id), String(uncertainty.ordinal)]))
    const blocks = database.prepare("SELECT b.finding_id, b.uncertainty_id FROM finding_intent_blocks b JOIN intent_uncertainties u ON u.id = b.uncertainty_id WHERE u.round_id = ? ORDER BY b.finding_id, u.ordinal").all(roundId) as Array<Record<string, unknown>>
    const blockedByFinding = new Map<number, string[]>()
    for (const block of blocks) {
      const values = blockedByFinding.get(Number(block.finding_id)) ?? []
      values.push(uncertaintyIds.get(Number(block.uncertainty_id)) as string)
      blockedByFinding.set(Number(block.finding_id), values)
    }
    const mappedFindings = findings.map((finding) => ({
      ...rowFinding(finding),
      blockedByUncertaintyIds: blockedByFinding.get(Number(finding.id)) ?? [],
      ...(finding.disposition === "ignored" ? { id: Number(finding.id) } : {}),
    }))
    const mappedUncertainties = uncertainties.map((uncertainty) => ({
      title: uncertainty.title as string,
      observedEvidence: uncertainty.observed_evidence as string,
      missingContext: uncertainty.missing_context as string,
      clarificationQuestion: uncertainty.clarification_question as string,
    }))
    return {
      id: row.id as string,
      reviewId: row.review_id as string,
      ordinal: Number(row.ordinal),
      payloadHash: row.payload_hash as string,
      ...(row.intent_type === null ? {} : { intent: { type: row.intent_type as "jira" | "local_file", ref: row.intent_ref as string } }),
      completedAt: row.completed_at as string,
      validFindings: mappedFindings.filter((finding): finding is NormalizedFinding => finding.disposition === "valid"),
      ignoredFindings: mappedFindings.filter((finding): finding is IgnoredSnapshot => finding.disposition === "ignored"),
      uncertainties: mappedUncertainties,
    }
  }
}
