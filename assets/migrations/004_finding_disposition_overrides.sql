CREATE TABLE finding_disposition_overrides (
  finding_id INTEGER PRIMARY KEY REFERENCES findings(id) ON DELETE CASCADE,
  disposition TEXT NOT NULL CHECK(disposition IN ('valid', 'ignored')),
  reason TEXT,
  updated_at TEXT NOT NULL,
  CHECK(
    (disposition = 'ignored' AND reason IS NOT NULL) OR
    (disposition = 'valid' AND reason IS NULL)
  )
);
