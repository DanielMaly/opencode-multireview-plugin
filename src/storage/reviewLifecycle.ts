import type { DatabaseOptions, SqliteDatabase } from "./database.js"
import { immediateTransaction, withDatabase } from "./database.js"
import { sessionValue, type IncompleteDiagnosticMarkerRequest, type IncompleteDiagnosticMarkerResult } from "../review.js"

const SELECT_SESSION_LOCK_SQL = "SELECT 1 AS present FROM review_locks WHERE session_id = ? LIMIT 1"
const SELECT_REVIEW_SESSION_LOCK_SQL = "SELECT 1 AS present FROM review_locks WHERE review_id = ? AND session_id = ?"
const SELECT_ACTIVE_REVIEW_SQL = "SELECT review_id FROM review_locks WHERE session_id = ? LIMIT 1"
const SELECT_PENDING_ROUND_SQL = "SELECT pending_round_id FROM review_locks WHERE review_id = ?"
const SELECT_PENDING_LANES_SQL = "SELECT lane FROM review_round_lanes WHERE review_id = ? AND round_id = ? AND status IS NULL ORDER BY lane"
const RESOLVE_LIFECYCLE_MARKERS_SQL = "UPDATE review_lifecycle_markers SET status = 'resolved', updated_at = ? WHERE session_id = ? AND review_id = ? AND status = 'open'"
const SELECT_INCOMPLETE_MARKER_SQL = "SELECT id, status FROM review_lifecycle_markers WHERE session_id = ? AND review_id = ? AND event = ? AND marker_key = ?"
const REOPEN_INCOMPLETE_MARKER_SQL = "UPDATE review_lifecycle_markers SET status = 'open', updated_at = ? WHERE id = ?"
const INSERT_INCOMPLETE_MARKER_SQL = "INSERT INTO review_lifecycle_markers (session_id, review_id, event, marker_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)"
const DELETE_OPEN_INCOMPLETE_MARKER_SQL = "DELETE FROM review_lifecycle_markers WHERE session_id = ? AND review_id = ? AND event = ? AND marker_key = ? AND status = 'open'"
const SELECT_LOCK_FOR_UNLOCK_SQL = "SELECT pending_round_id FROM review_locks WHERE review_id = ? AND fencing_token = ?"
const DELETE_REVIEW_ROUND_LANES_SQL = "DELETE FROM review_round_lanes WHERE review_id = ? AND round_id = ?"
const DELETE_REVIEW_LOCK_SQL = "DELETE FROM review_locks WHERE review_id = ? AND fencing_token = ?"

export type ActiveLaneSnapshot = {
  lanes: string[]
  laneAware: boolean
}

function now(): string {
  return new Date().toISOString()
}

export function hasActiveLockOwnedBySession(options: DatabaseOptions, sessionID: string, reviewId?: string): boolean {
  const owner = sessionValue(sessionID)
  if (!owner) return false
  return withDatabase(options, (database) => {
    const row = reviewId === undefined
      ? database.prepare(SELECT_SESSION_LOCK_SQL).get(owner)
      : database.prepare(SELECT_REVIEW_SESSION_LOCK_SQL).get(reviewId, owner)
    return row !== undefined
  })
}

export function activeReviewForSession(options: DatabaseOptions, sessionID: string): { reviewId: string; lanes: string[]; laneAware: boolean } | undefined {
  const owner = sessionValue(sessionID)
  if (!owner) return undefined
  return withDatabase(options, (database) => {
    const row = database.prepare(SELECT_ACTIVE_REVIEW_SQL).get(owner) as { review_id: string } | undefined
    if (!row) return undefined
    const snapshot = activeLaneSnapshot(database, row.review_id)
    return { reviewId: row.review_id, ...snapshot }
  })
}

export function activeLaneSnapshot(database: SqliteDatabase, reviewId: string): ActiveLaneSnapshot {
  const lock = database.prepare(SELECT_PENDING_ROUND_SQL).get(reviewId) as { pending_round_id: string | null } | undefined
  if (!lock || lock.pending_round_id === null) return { lanes: [], laneAware: false }
  const lanes = database.prepare(SELECT_PENDING_LANES_SQL).all(reviewId, lock.pending_round_id) as Array<{ lane: string }>
  return { lanes: lanes.map((lane) => lane.lane), laneAware: true }
}

export function resolveMarkers(database: SqliteDatabase, sessionID: string, reviewId: string, timestamp: string): void {
  database.prepare(RESOLVE_LIFECYCLE_MARKERS_SQL).run(timestamp, sessionID, reviewId)
}

export function recordIncompleteDiagnosticMarker(options: DatabaseOptions, request: IncompleteDiagnosticMarkerRequest): IncompleteDiagnosticMarkerResult {
  const sessionID = sessionValue(request.sessionID)
  if (!sessionID) throw new Error("sessionID must be a non-empty string")
  const markerKey = request.markerKey?.trim() || request.event
  return withDatabase(options, (database) => {
    return immediateTransaction(database, () => {
      const existing = database.prepare(SELECT_INCOMPLETE_MARKER_SQL).get(
        sessionID,
        request.reviewId,
        request.event,
        markerKey,
      ) as { id: number; status: "open" | "resolved" } | undefined
      if (existing?.status === "open") return { markerId: Number(existing.id), deduplicated: true }
      const timestamp = now()
      if (existing) {
        database.prepare(REOPEN_INCOMPLETE_MARKER_SQL).run(timestamp, existing.id)
        return { markerId: Number(existing.id), deduplicated: false }
      }
      const result = database.prepare(INSERT_INCOMPLETE_MARKER_SQL).run(
        sessionID,
        request.reviewId,
        request.event,
        markerKey,
        timestamp,
        timestamp,
      )
      return { markerId: Number(result.lastInsertRowid), deduplicated: false }
    })
  })
}

export function releaseIncompleteDiagnosticMarker(options: DatabaseOptions, request: IncompleteDiagnosticMarkerRequest): boolean {
  const owner = sessionValue(request.sessionID)
  if (!owner) return false
  const markerKey = request.markerKey?.trim() || request.event
  return withDatabase(options, (database) => database.prepare(DELETE_OPEN_INCOMPLETE_MARKER_SQL).run(
    owner,
    request.reviewId,
    request.event,
    markerKey,
  ).changes > 0)
}

export function unlock(options: DatabaseOptions, reviewId: string, fencingToken: string): boolean {
  return withDatabase(options, (database) => {
    return immediateTransaction(database, () => {
      const lock = database.prepare(SELECT_LOCK_FOR_UNLOCK_SQL).get(reviewId, fencingToken) as { pending_round_id: string | null } | undefined
      if (!lock) return false
      database.prepare(DELETE_REVIEW_ROUND_LANES_SQL).run(reviewId, lock.pending_round_id)
      return database.prepare(DELETE_REVIEW_LOCK_SQL).run(reviewId, fencingToken).changes > 0
    })
  })
}
