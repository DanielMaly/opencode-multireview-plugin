import type { DatabaseOptions } from "./database.js"
import { begin, complete } from "./reviewWrites.js"
import {
  assertReviewScope,
  getRound,
  getSummary,
  inspectLock,
  list,
  listRounds,
  listScoped,
} from "./reviewReads.js"
import {
  activeReviewForSession,
  hasActiveLockOwnedBySession,
  recordIncompleteDiagnosticMarker,
  releaseIncompleteDiagnosticMarker,
  unlock,
} from "./reviewLifecycle.js"
import type {
  BeginReviewRequest,
  BeginReviewResult,
  CompleteReviewRequest,
  IncompleteDiagnosticMarkerRequest,
  IncompleteDiagnosticMarkerResult,
  LockInfo,
  ReviewRound,
  ReviewScope,
  ReviewSummary,
  ScopedReviewSummary,
} from "../review.js"

export type {
  BeginReviewRequest,
  BeginReviewResult,
  CompleteReviewRequest,
  IncompleteDiagnosticMarkerRequest,
  IncompleteDiagnosticMarkerResult,
  LockInfo,
  ReviewRound,
  ReviewScope,
  ReviewSummary,
  ScopedReviewSummary,
} from "../review.js"

export class ReviewStore {
  constructor(private readonly options: DatabaseOptions = {}) {}

  begin(request: BeginReviewRequest): BeginReviewResult {
    return begin(this.options, request)
  }

  complete(request: CompleteReviewRequest): { roundId: string; idempotent: boolean } {
    return complete(this.options, request)
  }

  assertReviewScope(reviewId: string, scope: ReviewScope): void {
    assertReviewScope(this.options, reviewId, scope)
  }

  list(projectKey?: string): ReviewSummary[] {
    return list(this.options, projectKey)
  }

  listScoped(scope: ReviewScope): ScopedReviewSummary[] {
    return listScoped(this.options, scope)
  }

  getSummary(reviewId: string): ReviewSummary | undefined {
    return getSummary(this.options, reviewId)
  }

  listRounds(reviewId: string): ReviewRound[] {
    return listRounds(this.options, reviewId)
  }

  getRound(reviewId: string, roundId?: string): ReviewRound | undefined {
    return getRound(this.options, reviewId, roundId)
  }

  inspectLock(reviewId: string): LockInfo | undefined {
    return inspectLock(this.options, reviewId)
  }

  hasActiveLockOwnedBySession(sessionID: string, reviewId?: string): boolean {
    return hasActiveLockOwnedBySession(this.options, sessionID, reviewId)
  }

  activeReviewForSession(sessionID: string): { reviewId: string; lanes: string[]; laneAware: boolean } | undefined {
    return activeReviewForSession(this.options, sessionID)
  }

  recordIncompleteDiagnosticMarker(request: IncompleteDiagnosticMarkerRequest): IncompleteDiagnosticMarkerResult {
    return recordIncompleteDiagnosticMarker(this.options, request)
  }

  releaseIncompleteDiagnosticMarker(request: IncompleteDiagnosticMarkerRequest): boolean {
    return releaseIncompleteDiagnosticMarker(this.options, request)
  }

  unlock(reviewId: string, fencingToken: string): boolean {
    return unlock(this.options, reviewId, fencingToken)
  }
}
