import type { DatabaseOptions } from "./database.js"
import { ReviewStore } from "./reviews.js"
import type { IncompleteDiagnosticMarkerRequest, IncompleteDiagnosticMarkerResult } from "../review.js"

export interface ReviewLifecycle {
  ownsActiveLock(sessionID: string, reviewId?: string): boolean
  activeReviewForSession(sessionID: string): { reviewId: string; lanes: string[] } | undefined
  recordIncompleteDiagnosticMarker(request: IncompleteDiagnosticMarkerRequest): IncompleteDiagnosticMarkerResult
  releaseIncompleteDiagnosticMarker(request: IncompleteDiagnosticMarkerRequest): boolean
}

export class PersistentReviewLifecycle implements ReviewLifecycle {
  private readonly store: ReviewStore

  constructor(options: DatabaseOptions = {}) {
    this.store = new ReviewStore(options)
  }

  ownsActiveLock(sessionID: string, reviewId?: string): boolean {
    return this.store.hasActiveLockOwnedBySession(sessionID, reviewId)
  }

  activeReviewForSession(sessionID: string): { reviewId: string; lanes: string[] } | undefined {
    return this.store.activeReviewForSession(sessionID)
  }

  recordIncompleteDiagnosticMarker(request: IncompleteDiagnosticMarkerRequest): IncompleteDiagnosticMarkerResult {
    return this.store.recordIncompleteDiagnosticMarker(request)
  }

  releaseIncompleteDiagnosticMarker(request: IncompleteDiagnosticMarkerRequest): boolean {
    return this.store.releaseIncompleteDiagnosticMarker(request)
  }
}
