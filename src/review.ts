import type {
  FindingDisposition,
  FindingInput,
  IntentUncertainty,
  NormalizedFinding,
} from "./findings.js"
import type { NormalizedTarget, ResolvedReviewIdentity } from "./repository.js"
import type { ReviewLane } from "./lanes.js"

export const intentTypes = ["jira", "local_file"] as const
export type IntentType = (typeof intentTypes)[number]

export interface IntentReference {
  type: IntentType
  ref: string
}

export interface BeginReviewRequest {
  identity: ResolvedReviewIdentity
  target: NormalizedTarget
  intent?: IntentReference | null
  lanes?: ReviewLane[]
  sessionID?: string
}

export type LaneResultStatus = "completed" | "failed"

export interface LaneResult {
  lane: ReviewLane
  status: LaneResultStatus
  failureReason?: string
}

export interface FindingSnapshot extends NormalizedFinding {
  id: number
  dispositionOverridden?: true
  originalDisposition?: FindingDisposition
  originalWontfix?: string
}

export type IgnoredSnapshot = FindingSnapshot

export type BeginReviewResult = {
  reviewId: string
  locked: false
  roundId: string
  fencingToken: string
  acquiredAt: string
  previousIgnored: IgnoredSnapshot[]
  lanes: ReviewLane[]
} | {
  reviewId: string
  locked: true
  acquiredAt: string
  previousIgnored: []
  lanes?: ReviewLane[]
}

export type ReviewScope = Pick<ResolvedReviewIdentity, "projectKey" | "worktreePath">

export interface SetFindingDispositionRequest {
  findingId: number
  disposition: FindingDisposition
  reason?: string
  scope?: ReviewScope
}

export interface SetFindingDispositionResult {
  reviewId: string
  roundId: string
  findingId: number
  disposition: FindingDisposition
  wontfix?: string
  originalDisposition: FindingDisposition
  originalWontfix?: string
  overridden: boolean
  idempotent: boolean
}

export interface CompleteReviewRequest {
  reviewId: string
  roundId: string
  fencingToken: string
  sessionID?: string
  intent?: IntentReference | null
  laneResults?: LaneResult[]
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

export type ScopedReviewSummary = Omit<ReviewSummary, "lock"> & {
  lock?: { acquiredAt: string }
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
  lanes?: ReviewLane[]
  laneResults?: LaneResult[]
  completedAt: string
  validFindings: FindingSnapshot[]
  ignoredFindings: FindingSnapshot[]
  uncertainties: IntentUncertainty[]
}

export const LEGACY_SESSION_ID = "__legacy_unbound__"

export function sessionValue(sessionID: string | undefined): string | null {
  const value = sessionID?.trim() || null
  return value === LEGACY_SESSION_ID ? null : value
}

export function intentValues(intent: IntentReference | null | undefined): [string | null, string | null] {
  return intent ? [intent.type, intent.ref] : [null, null]
}
