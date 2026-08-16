ALTER TABLE review_locks ADD COLUMN pending_round_id TEXT;

CREATE TABLE review_round_lanes (
  round_id TEXT NOT NULL,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  lane TEXT NOT NULL,
  status TEXT CHECK(status IN ('completed','failed') OR status IS NULL),
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(round_id, lane)
);

CREATE INDEX review_round_lanes_review_idx
  ON review_round_lanes(review_id, round_id);

CREATE TABLE findings_without_category_check (
  id INTEGER PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('valid','ignored')),
  severity TEXT NOT NULL CHECK(severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  wontfix TEXT,
  source_agents_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE(round_id, disposition, ordinal),
  CHECK((disposition='ignored' AND wontfix IS NOT NULL) OR (disposition='valid' AND wontfix IS NULL))
);

INSERT INTO findings_without_category_check
  SELECT id, round_id, ordinal, disposition, severity, category, title, body_markdown, wontfix, source_agents_json, content_hash
  FROM findings;

CREATE TABLE finding_intent_blocks_without_category_check (
  finding_id INTEGER NOT NULL REFERENCES findings_without_category_check(id) ON DELETE CASCADE,
  uncertainty_id INTEGER NOT NULL REFERENCES intent_uncertainties(id) ON DELETE CASCADE,
  PRIMARY KEY(finding_id, uncertainty_id)
);

INSERT INTO finding_intent_blocks_without_category_check
  SELECT finding_id, uncertainty_id FROM finding_intent_blocks;

DROP TABLE finding_intent_blocks;
DROP TABLE findings;
ALTER TABLE findings_without_category_check RENAME TO findings;
ALTER TABLE finding_intent_blocks_without_category_check RENAME TO finding_intent_blocks;

CREATE INDEX findings_order_idx ON findings(round_id, disposition, ordinal);
