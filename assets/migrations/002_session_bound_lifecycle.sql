ALTER TABLE review_locks ADD COLUMN session_id TEXT NOT NULL DEFAULT '__legacy_unbound__';

ALTER TABLE review_rounds ADD COLUMN completed_session_id TEXT;

CREATE TABLE review_lifecycle_markers (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  event TEXT NOT NULL CHECK(event = 'session.error'),
  marker_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','resolved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, review_id, event, marker_key)
);

CREATE INDEX review_lifecycle_markers_active_idx
  ON review_lifecycle_markers(session_id, review_id, status);
