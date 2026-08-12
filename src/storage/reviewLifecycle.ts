import type { DatabaseOptions, SqliteDatabase } from "./database.js"
import { withDatabase } from "./database.js"
import { sessionValue, type IncompleteDiagnosticMarkerRequest, type IncompleteDiagnosticMarkerResult } from "../review.js"

function now(): string {
  return new Date().toISOString()
}

export function hasActiveLockOwnedBySession(options: DatabaseOptions, sessionID: string, reviewId?: string): boolean {
  const owner = sessionValue(sessionID)
  if (!owner) return false
  return withDatabase(options, (database) => {
    const row = reviewId === undefined
      ? database.prepare("SELECT 1 AS present FROM review_locks WHERE session_id = ? LIMIT 1").get(owner)
      : database.prepare("SELECT 1 AS present FROM review_locks WHERE review_id = ? AND session_id = ?").get(reviewId, owner)
    return row !== undefined
  })
}

export function activeReviewForSession(options: DatabaseOptions, sessionID: string): { reviewId: string } | undefined {
  const owner = sessionValue(sessionID)
  if (!owner) return undefined
  return withDatabase(options, (database) => {
    const row = database.prepare("SELECT review_id FROM review_locks WHERE session_id = ? LIMIT 1").get(owner) as { review_id: string } | undefined
    return row ? { reviewId: row.review_id } : undefined
  })
}

export function resolveMarkers(database: SqliteDatabase, sessionID: string, reviewId: string, timestamp: string): void {
  database.prepare("UPDATE review_lifecycle_markers SET status = 'resolved', updated_at = ? WHERE session_id = ? AND review_id = ? AND status = 'open'").run(timestamp, sessionID, reviewId)
}

export function recordIncompleteDiagnosticMarker(options: DatabaseOptions, request: IncompleteDiagnosticMarkerRequest): IncompleteDiagnosticMarkerResult {
  const sessionID = sessionValue(request.sessionID)
  if (!sessionID) throw new Error("sessionID must be a non-empty string")
  const markerKey = request.markerKey?.trim() || request.event
  return withDatabase(options, (database) => {
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

export function releaseIncompleteDiagnosticMarker(options: DatabaseOptions, request: IncompleteDiagnosticMarkerRequest): boolean {
  const owner = sessionValue(request.sessionID)
  if (!owner) return false
  const markerKey = request.markerKey?.trim() || request.event
  return withDatabase(options, (database) => database.prepare("DELETE FROM review_lifecycle_markers WHERE session_id = ? AND review_id = ? AND event = ? AND marker_key = ? AND status = 'open'").run(
    owner,
    request.reviewId,
    request.event,
    markerKey,
  ).changes > 0)
}

export function unlock(options: DatabaseOptions, reviewId: string, fencingToken: string): boolean {
  return withDatabase(options, (database) => database.prepare("DELETE FROM review_locks WHERE review_id = ? AND fencing_token = ?").run(reviewId, fencingToken).changes > 0)
}
