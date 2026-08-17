import type { DatabaseOptions, SqliteDatabase } from "./database.js"
import { withDatabase } from "./database.js"
import type { NormalizedFinding } from "../findings.js"
import type {
  IgnoredSnapshot,
  IntentType,
  LockInfo,
  ReviewRound,
  ReviewScope,
  ReviewSummary,
  ScopedReviewSummary,
} from "../review.js"
import { LEGACY_SESSION_ID } from "../review.js"
import { findingCategoriesForLanes } from "../lanes.js"

const SUMMARY_ROWS_QUERY = "SELECT r.id, r.target_kind, r.target_key, r.target_label, r.base_ref, r.base_commit, r.current_intent_type, r.current_intent_ref, rr.id AS latest_round_id, rr.completed_at AS latest_round_at, rl.fencing_token, rl.acquired_at FROM reviews r JOIN projects p ON p.id = r.project_id JOIN worktrees w ON w.id = r.worktree_id LEFT JOIN review_rounds rr ON rr.review_id = r.id AND rr.ordinal = (SELECT MAX(ordinal) FROM review_rounds WHERE review_id = r.id) LEFT JOIN review_locks rl ON rl.review_id = r.id WHERE (? IS NULL OR p.project_key = ?) AND (? IS NULL OR r.target_kind != 'uncommitted' OR w.path = ?) AND (? IS NULL OR r.id = ?) ORDER BY r.project_id, r.target_kind, r.target_key, r.base_commit"
const LATEST_ROUND_QUERY = "SELECT id, review_id, ordinal, payload_hash, intent_type, intent_ref, completed_at FROM review_rounds WHERE review_id = ? ORDER BY ordinal DESC LIMIT 1"
const SPECIFIC_ROUND_QUERY = "SELECT id, review_id, ordinal, payload_hash, intent_type, intent_ref, completed_at FROM review_rounds WHERE review_id = ? AND id = ?"

type FindingRow = {
  id: number
  disposition: "valid" | "ignored"
  severity: NormalizedFinding["severity"]
  category: NormalizedFinding["category"]
  title: string
  body_markdown: string
  wontfix: string | null
  source_agents_json: string
  content_hash: string
}

type SummaryRow = {
  id: string
  target_kind: string
  target_key: string
  target_label: string
  base_ref: string
  base_commit: string
  current_intent_type: string | null
  current_intent_ref: string | null
  latest_round_id: string | null
  latest_round_at: string | null
  fencing_token: string | null
  acquired_at: string | null
}

type RoundRow = {
  id: string
  review_id: string
  ordinal: number
  payload_hash: string
  intent_type: IntentType | null
  intent_ref: string | null
  completed_at: string
}

type LaneRow = {
  lane: string
  status: "completed" | "failed" | null
  failure_reason: string | null
}

function rowFinding(row: FindingRow): NormalizedFinding {
  return {
    disposition: row.disposition,
    severity: row.severity,
    category: row.category,
    title: row.title,
    bodyMarkdown: row.body_markdown,
    ...(row.wontfix === null ? {} : { wontfix: row.wontfix }),
    sourceAgents: JSON.parse(row.source_agents_json) as string[],
    blockedByUncertaintyIds: [],
    contentHash: row.content_hash,
  }
}

function summary(value: SummaryRow): ReviewSummary {
  return {
    id: value.id,
    targetKind: value.target_kind,
    targetKey: value.target_key,
    targetLabel: value.target_label,
    baseRef: value.base_ref,
    baseCommit: value.base_commit,
    ...(value.current_intent_type === null ? {} : { currentIntentType: value.current_intent_type, currentIntentRef: value.current_intent_ref as string }),
    ...(value.latest_round_id === null ? {} : { latestRoundId: value.latest_round_id, latestRoundAt: value.latest_round_at as string }),
    ...(value.fencing_token === null ? {} : { lock: { fencingToken: value.fencing_token, acquiredAt: value.acquired_at as string } }),
  }
}

function scopedSummary(value: SummaryRow): ScopedReviewSummary {
  const result = summary(value)
  return result.lock === undefined
    ? result
    : { ...result, lock: { acquiredAt: result.lock.acquiredAt } }
}

function summaryRows(database: SqliteDatabase, scope: { projectKey?: string; worktreePath?: string; reviewId?: string }): SummaryRow[] {
  return database.prepare(SUMMARY_ROWS_QUERY).all(
    scope.projectKey ?? null,
    scope.projectKey ?? null,
    scope.worktreePath ?? null,
    scope.worktreePath ?? null,
    scope.reviewId ?? null,
    scope.reviewId ?? null,
  ) as SummaryRow[]
}

export function previousIgnored(database: SqliteDatabase, reviewId: string, lanes?: string[]): IgnoredSnapshot[] {
  const rows = database.prepare("SELECT id, disposition, severity, category, title, body_markdown, wontfix, source_agents_json, content_hash FROM findings WHERE round_id = (SELECT id FROM review_rounds WHERE review_id = ? ORDER BY ordinal DESC LIMIT 1) AND disposition = 'ignored' ORDER BY ordinal").all(reviewId) as FindingRow[]
  const categories = lanes === undefined ? undefined : new Set(findingCategoriesForLanes(lanes))
  return rows.filter((row) => categories === undefined || categories.has(row.category)).map((row) => ({ id: Number(row.id), ...rowFinding(row) }))
}

export function assertReviewScope(options: DatabaseOptions, reviewId: string, scope: ReviewScope): void {
  withDatabase(options, (database) => {
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

export function list(options: DatabaseOptions, projectKey?: string): ReviewSummary[] {
  return withDatabase(options, (database) => summaryRows(database, { projectKey }).map(summary))
}

export function listScoped(options: DatabaseOptions, scope: ReviewScope): ScopedReviewSummary[] {
  return withDatabase(options, (database) => summaryRows(database, scope).map(scopedSummary))
}

export function getSummary(options: DatabaseOptions, reviewId: string): ReviewSummary | undefined {
  return withDatabase(options, (database) => {
    const row = summaryRows(database, { reviewId })[0]
    return row ? summary(row) : undefined
  })
}

export function listRounds(options: DatabaseOptions, reviewId: string): ReviewRound[] {
  return withDatabase(options, (database) => {
    const rounds = database.prepare("SELECT id, review_id, ordinal, payload_hash, intent_type, intent_ref, completed_at FROM review_rounds WHERE review_id = ? ORDER BY ordinal").all(reviewId) as RoundRow[]
    return rounds.map((round) => readRound(database, round))
  })
}

export function getRound(options: DatabaseOptions, reviewId: string, roundId?: string): ReviewRound | undefined {
  return withDatabase(options, (database) => {
    const row = roundId === undefined
      ? database.prepare(LATEST_ROUND_QUERY).get(reviewId)
      : database.prepare(SPECIFIC_ROUND_QUERY).get(reviewId, roundId)
    return row ? readRound(database, row as RoundRow) : undefined
  })
}

export function inspectLock(options: DatabaseOptions, reviewId: string): LockInfo | undefined {
  return withDatabase(options, (database) => {
    const row = database.prepare("SELECT review_id, fencing_token, acquired_at, session_id FROM review_locks WHERE review_id = ?").get(reviewId) as {
      review_id: string
      fencing_token: string
      acquired_at: string
      session_id: string
    } | undefined
    return row ? {
      reviewId: row.review_id,
      fencingToken: row.fencing_token,
      acquiredAt: row.acquired_at,
      ...(row.session_id === LEGACY_SESSION_ID ? {} : { sessionID: row.session_id }),
    } : undefined
  })
}

function readRound(database: SqliteDatabase, row: RoundRow): ReviewRound {
  const findings = database.prepare("SELECT id, disposition, severity, category, title, body_markdown, wontfix, source_agents_json, content_hash FROM findings WHERE round_id = ? ORDER BY disposition, ordinal").all(row.id) as FindingRow[]
  const uncertainties = database.prepare("SELECT id, ordinal, title, observed_evidence, missing_context, clarification_question FROM intent_uncertainties WHERE round_id = ? ORDER BY ordinal").all(row.id) as Array<{
    id: number
    ordinal: number
    title: string
    observed_evidence: string
    missing_context: string
    clarification_question: string
  }>
  const uncertaintyIds = new Map(uncertainties.map((uncertainty) => [Number(uncertainty.id), String(uncertainty.ordinal)]))
  const blocks = database.prepare("SELECT b.finding_id, b.uncertainty_id FROM finding_intent_blocks b JOIN intent_uncertainties u ON u.id = b.uncertainty_id WHERE u.round_id = ? ORDER BY b.finding_id, u.ordinal").all(row.id) as Array<{ finding_id: number; uncertainty_id: number }>
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
  const laneTable = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'review_round_lanes'").get()
  const lanes = laneTable === undefined
    ? []
    : database.prepare("SELECT lane, status, failure_reason FROM review_round_lanes WHERE round_id = ? ORDER BY lane").all(row.id) as LaneRow[]
  return {
    id: row.id,
    reviewId: row.review_id,
    ordinal: Number(row.ordinal),
    payloadHash: row.payload_hash,
    ...(row.intent_type === null ? {} : { intent: { type: row.intent_type, ref: row.intent_ref as string } }),
    ...(lanes.length === 0 ? {} : {
      lanes: lanes.map((lane) => lane.lane),
      laneResults: lanes.filter((lane): lane is LaneRow & { status: "completed" | "failed" } => lane.status !== null).map((lane) => ({
        lane: lane.lane,
        status: lane.status,
        ...(lane.failure_reason === null ? {} : { failureReason: lane.failure_reason }),
      })),
    }),
    completedAt: row.completed_at,
    validFindings: mappedFindings.filter((finding): finding is NormalizedFinding => finding.disposition === "valid"),
    ignoredFindings: mappedFindings.filter((finding): finding is IgnoredSnapshot => finding.disposition === "ignored"),
    uncertainties: uncertainties.map((uncertainty) => ({
      title: uncertainty.title,
      observedEvidence: uncertainty.observed_evidence,
      missingContext: uncertainty.missing_context,
      clarificationQuestion: uncertainty.clarification_question,
    })),
  }
}
