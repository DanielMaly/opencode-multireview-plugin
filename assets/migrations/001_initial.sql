CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  project_key TEXT UNIQUE NOT NULL,
  root_path TEXT NOT NULL,
  git_common_dir TEXT,
  origin_url TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE worktrees (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  path TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(project_id, path)
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  worktree_id INTEGER NOT NULL REFERENCES worktrees(id),
  target_kind TEXT NOT NULL,
  target_key TEXT NOT NULL,
  target_label TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  branch TEXT,
  head_commit TEXT,
  pr_provider TEXT,
  pr_repository TEXT,
  pr_number INTEGER,
  current_intent_type TEXT CHECK(current_intent_type IN ('jira','local_file') OR current_intent_type IS NULL),
  current_intent_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, target_key, base_commit)
);

CREATE TABLE review_locks (
  review_id TEXT PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,
  fencing_token TEXT UNIQUE NOT NULL,
  acquired_at TEXT NOT NULL
);

CREATE TABLE review_rounds (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id),
  ordinal INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  intent_type TEXT CHECK(intent_type IN ('jira','local_file') OR intent_type IS NULL),
  intent_ref TEXT,
  completed_at TEXT NOT NULL,
  UNIQUE(review_id, ordinal)
);

CREATE TABLE findings (
  id INTEGER PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('valid','ignored')),
  severity TEXT NOT NULL CHECK(severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  category TEXT NOT NULL CHECK(category IN ('CORRECTNESS','CODESTYLE','TESTING','INTENT')),
  title TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  wontfix TEXT,
  source_agents_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE(round_id, disposition, ordinal),
  CHECK((disposition='ignored' AND wontfix IS NOT NULL) OR (disposition='valid' AND wontfix IS NULL))
);

CREATE TABLE intent_uncertainties (
  id INTEGER PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  observed_evidence TEXT NOT NULL,
  missing_context TEXT NOT NULL,
  clarification_question TEXT NOT NULL,
  UNIQUE(round_id, ordinal)
);

CREATE TABLE finding_intent_blocks (
  finding_id INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  uncertainty_id INTEGER NOT NULL REFERENCES intent_uncertainties(id) ON DELETE CASCADE,
  PRIMARY KEY(finding_id, uncertainty_id)
);

CREATE INDEX projects_key_idx ON projects(project_key);
CREATE INDEX reviews_lookup_idx ON reviews(project_id, target_key, base_commit);
CREATE INDEX review_rounds_latest_idx ON review_rounds(review_id, ordinal DESC);
CREATE INDEX worktrees_listing_idx ON worktrees(project_id, path);
CREATE INDEX findings_order_idx ON findings(round_id, disposition, ordinal);
