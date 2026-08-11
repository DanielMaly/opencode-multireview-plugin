import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { openDatabase } from "../dist/storage/database.js";
import { ReviewStore } from "../dist/storage/reviews.js";
import { PersistentReviewLifecycle } from "../dist/storage/lifecycle.js";
import { normalizeTarget, resolveBase, resolveRepositoryIdentity } from "../dist/repository.js";
import { ensureDatabaseDirectory } from "../dist/storage/path.js";
import { createMmarTools } from "../dist/tools.js";
import { hashRoundPayload } from "../dist/findings.js";
import { LEGACY_SESSION_ID } from "../dist/review.js";

function temporaryPath() {
  const directory = mkdtempSync(join(tmpdir(), "opencode-multireview-storage-"));
  return { directory, databasePath: join(directory, "reviews.sqlite") };
}

function identity(baseCommit = "base-commit") {
  return {
    projectKey: "project-key",
    rootPath: "/project",
    gitCommonDir: "/project/.git",
    originUrl: "https://example.test/project.git",
    worktreePath: "/project/worktree",
    branch: "feature",
    headCommit: "head-commit",
    isGit: true,
    baseRef: "main",
    baseCommit,
  };
}

function target(key) {
  return { kind: "custom", key, label: key };
}

function validFinding(title = "Keep this") {
  return {
    disposition: "valid",
    severity: "HIGH",
    category: "CORRECTNESS",
    title,
    bodyMarkdown: "The body",
    sourceAgents: ["correctness"],
  };
}

function ignoredFinding(title = "Ignore this") {
  return {
    disposition: "ignored",
    severity: "LOW",
    category: "CODESTYLE",
    title,
    bodyMarkdown: "The reason",
    wontfix: "Accepted trade-off",
    sourceAgents: ["codestyle"],
  };
}

test("migrates a fresh database and is repeatable with rollback journal and foreign keys", () => {
  const { directory, databasePath } = temporaryPath();
  try {
    const first = openDatabase({ databasePath });
    assert.equal(first.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 2);
    assert.equal(first.prepare("SELECT session_id FROM review_locks").get(), undefined);
    assert.equal(first.prepare("SELECT name FROM sqlite_master WHERE name = 'review_lifecycle_markers'").get().name, "review_lifecycle_markers");
    assert.equal(first.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(first.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
    first.close();
    const second = openDatabase({ databasePath });
    assert.equal(second.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 2);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("upgrades v1 lifecycle data and supports legacy completion compatibility", async () => {
  const { directory, databasePath } = temporaryPath();
  const migrationDirectory = join(directory, "v1-migrations");
  mkdirSync(migrationDirectory);
  writeFileSync(join(migrationDirectory, "001_initial.sql"), readFileSync(new URL("../assets/migrations/001_initial.sql", import.meta.url)));
  const activeReviewId = randomUUID();
  const completedReviewId = randomUUID();
  const activeRoundId = randomUUID();
  const completedRoundId = randomUUID();
  const activeToken = randomUUID();
  const completedToken = randomUUID();
  const timestamp = "2026-01-01T00:00:00.000Z";

  try {
    const repository = resolveRepositoryIdentity(directory);
    const v1 = openDatabase({ databasePath, migrationDirectory });
    v1.prepare("INSERT INTO projects (id, project_key, root_path, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run(1, repository.projectKey, repository.rootPath, timestamp, timestamp);
    v1.prepare("INSERT INTO worktrees (id, project_id, path, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run(1, 1, repository.worktreePath, timestamp, timestamp);
    const insertReview = (id, key) => v1.prepare("INSERT INTO reviews (id, project_id, worktree_id, target_kind, target_key, target_label, base_ref, base_commit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      1,
      1,
      "custom",
      key,
      key,
      "main",
      "base",
      timestamp,
      timestamp,
    );
    insertReview(activeReviewId, "legacy-active");
    insertReview(completedReviewId, "legacy-completed");
    v1.prepare("INSERT INTO review_locks (review_id, fencing_token, acquired_at) VALUES (?, ?, ?)").run(activeReviewId, activeToken, timestamp);
    v1.prepare("INSERT INTO review_rounds (id, review_id, ordinal, payload_hash, completed_at) VALUES (?, ?, ?, ?, ?)").run(
      completedRoundId,
      completedReviewId,
      1,
      hashRoundPayload({ validFindings: [], ignoredFindings: [], uncertainties: [] }),
      timestamp,
    );
    v1.close();

    const upgraded = openDatabase({ databasePath });
    assert.equal(upgraded.prepare("SELECT session_id FROM review_locks WHERE review_id = ?").get(activeReviewId).session_id, LEGACY_SESSION_ID);
    assert.equal(upgraded.prepare("SELECT completed_session_id FROM review_rounds WHERE id = ?").get(completedRoundId).completed_session_id, null);
    upgraded.close();

    const tools = createMmarTools({ databasePath });
    const context = { agent: "mmar_orchestrator", directory, worktree: directory, sessionID: "legacy-session" };
    const activeCompletion = JSON.parse(await tools.mmar_complete.execute({
      reviewId: activeReviewId,
      roundId: activeRoundId,
      fencingToken: activeToken,
    }, context));
    assert.deepEqual(activeCompletion, { roundId: activeRoundId, idempotent: false });

    const completedRetry = JSON.parse(await tools.mmar_complete.execute({
      reviewId: completedReviewId,
      roundId: completedRoundId,
      fencingToken: completedToken,
    }, context));
    assert.deepEqual(completedRetry, { roundId: completedRoundId, idempotent: true });

    const store = new ReviewStore({ databasePath });
    assert.equal(store.inspectLock(activeReviewId), undefined);
    const database = openDatabase({ databasePath });
    assert.equal(database.prepare("SELECT completed_session_id FROM review_rounds WHERE id = ?").get(completedRoundId).completed_session_id, "legacy-session");
    database.close();
    await assert.rejects(() => tools.mmar_complete.execute({
      reviewId: completedReviewId,
      roundId: completedRoundId,
      fencingToken: completedToken,
    }, { ...context, sessionID: "other-session" }), /session ownership/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a changed applied migration checksum", () => {
  const { directory, databasePath } = temporaryPath();
  const migrationDirectory = join(directory, "migrations");
  mkdirSync(migrationDirectory);
  const migration = join(migrationDirectory, "001_initial.sql");
  writeFileSync(migration, readFileSync(new URL("../assets/migrations/001_initial.sql", import.meta.url)));
  const first = openDatabase({ databasePath, migrationDirectory });
  first.close();
  writeFileSync(migration, `${readFileSync(migration, "utf8")}\n-- changed`);
  assert.throws(() => openDatabase({ databasePath, migrationDirectory }), /checksum mismatch/);
  rmSync(directory, { recursive: true, force: true });
});

test("applies a pending contiguous migration and rolls back a failed migration", () => {
  const { directory, databasePath } = temporaryPath();
  const migrationDirectory = join(directory, "migrations");
  mkdirSync(migrationDirectory);
  const initial = readFileSync(new URL("../assets/migrations/001_initial.sql", import.meta.url));
  writeFileSync(join(migrationDirectory, "001_initial.sql"), initial);
  const first = openDatabase({ databasePath, migrationDirectory });
  first.close();
  writeFileSync(join(migrationDirectory, "002_pending.sql"), "CREATE TABLE pending_check (value TEXT NOT NULL);");
  const second = openDatabase({ databasePath, migrationDirectory });
  assert.equal(second.prepare("SELECT name FROM sqlite_master WHERE name = 'pending_check'").get().name, "pending_check");
  second.close();
  writeFileSync(join(migrationDirectory, "003_failed.sql"), "CREATE TABLE broken (value TEXT); INSERT INTO missing_table VALUES ('x');");
  assert.throws(() => openDatabase({ databasePath, migrationDirectory }), /migration 3_failed failed/);
  rmSync(join(migrationDirectory, "003_failed.sql"));
  const afterFailure = openDatabase({ databasePath, migrationDirectory });
  assert.equal(afterFailure.prepare("SELECT name FROM sqlite_master WHERE name = 'broken'").get(), undefined);
  afterFailure.close();
  rmSync(directory, { recursive: true, force: true });
});

test("resolves a real Git linked worktree to one project and rejects an unresolvable base", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-multireview-git-"));
  const linkedDirectory = `${directory}-linked`;
  const run = (args, cwd) => {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  };
  try {
    run(["init", "-q"], directory);
    run(["config", "user.email", "test@example.test"], directory);
    run(["config", "user.name", "Test"], directory);
    writeFileSync(join(directory, "file.txt"), "one\n");
    run(["add", "."], directory);
    run(["commit", "-qm", "initial"], directory);
    const result = resolveRepositoryIdentity(directory);
    run(["worktree", "add", "-q", "-b", "linked", linkedDirectory, "HEAD"], directory);
    const linkedResult = resolveRepositoryIdentity(linkedDirectory);
    assert.equal(result.isGit, true);
    assert.equal(result.projectKey, linkedResult.projectKey);
    assert.notEqual(result.worktreePath, linkedResult.worktreePath);
    assert.equal(resolveBase(directory, "HEAD").baseCommit, result.headCommit);
    assert.throws(() => resolveBase(directory, "missing-base"), /Unable to resolve base ref/);
  } finally {
    rmSync(linkedDirectory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not misclassify a Git worktree with an execution failure as non-Git", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-multireview-broken-git-"));
  try {
    mkdirSync(join(directory, ".git"));
    assert.throws(() => resolveRepositoryIdentity(directory), /Git repository detection failed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("isolates scopes, returns previous ignored snapshots, fences locks, and supports idempotent completion", () => {
  const { directory, databasePath } = temporaryPath();
  try {
    const store = new ReviewStore({ databasePath });
    const first = store.begin({ identity: identity(), target: target("A"), intent: { type: "jira", ref: "PROJ-1" } });
    assert.equal(first.locked, false);
    assert.equal(store.getSummary(first.reviewId).id, first.reviewId);
    assert.equal(store.getSummary("missing-review"), undefined);
    const contention = store.begin({ identity: identity(), target: target("A") });
    assert.equal(contention.locked, true);
    assert.equal(contention.reviewId, first.reviewId);
    assert.equal(store.list()[0].currentIntentRef, "PROJ-1");
    const firstCompletion = { reviewId: first.reviewId, roundId: first.roundId, fencingToken: first.fencingToken, intent: { type: "jira", ref: "PROJ-1" }, ignoredFindings: [ignoredFinding()] };
    assert.equal(store.complete(firstCompletion).idempotent, false);
    assert.equal(store.complete(firstCompletion).idempotent, true);
    assert.throws(() => store.complete({ reviewId: first.reviewId, roundId: first.roundId, fencingToken: first.fencingToken, ignoredFindings: [ignoredFinding("Changed")] }), /payload differs/);
    const second = store.begin({ identity: identity(), target: target("A") });
    assert.equal(second.previousIgnored.length, 1);
    const differentScope = store.begin({ identity: identity(), target: target("B") });
    assert.equal(differentScope.previousIgnored.length, 0);
    assert.equal(store.unlock(first.reviewId, first.fencingToken), false);
    assert.equal(store.unlock(first.reviewId, second.fencingToken), true);
    assert.throws(() => store.complete({ reviewId: first.reviewId, roundId: second.roundId, fencingToken: second.fencingToken, validFindings: [validFinding()] }), /stale or missing/);
    const third = store.begin({ identity: identity(), target: target("A") });
    assert.equal(third.previousIgnored.length, 1);
    store.complete({ reviewId: differentScope.reviewId, roundId: differentScope.roundId, fencingToken: differentScope.fencingToken, validFindings: [validFinding()] });
    store.complete({ reviewId: third.reviewId, roundId: third.roundId, fencingToken: third.fencingToken, validFindings: [validFinding("Second")], intent: null });
    assert.deepEqual(store.listRounds(first.reviewId).map((round) => round.ordinal), [1, 2]);
    assert.equal(store.getRound(first.reviewId, first.roundId).intent.ref, "PROJ-1");
    assert.equal(store.getRound(first.reviewId, third.roundId).intent, undefined);
    const reviews = store.list();
    assert.deepEqual(reviews.map((review) => review.targetKey), ["A", "B"]);
    assert.equal(reviews[0].currentIntentType, undefined);
    assert.equal(reviews[0].latestRoundId, third.roundId);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("normalizes target identity and non-Git repositories without shell interpolation", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-multireview-nongit-"));
  try {
    const result = resolveRepositoryIdentity(directory);
    assert.equal(result.isGit, false);
    assert.equal(normalizeTarget({ kind: "uncommitted" }, result).key, result.worktreePath);
    assert.throws(() => normalizeTarget({ kind: "pull_request", provider: "github", repository: "org/repo", number: 0 }, result), /positive integer/);
    assert.throws(() => normalizeTarget({ kind: "branch", branch: "   " }, result), /branch must be a non-empty string/);
    assert.throws(() => normalizeTarget({ kind: "commit", commit: "" }, result), /commit must be a non-empty string/);
    assert.throws(() => normalizeTarget({ kind: "custom", changeset: "\n" }, result), /custom changeset must be a non-empty string/);
    assert.throws(() => resolveBase(directory, ""), /base_ref must be a non-empty Git ref/);
    assert.throws(() => resolveBase(directory, "HEAD\n--upload-pack=evil"), /base_ref must be a non-empty Git ref/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hardens an existing database parent directory on supported platforms", () => {
  if (process.platform === "win32") return;
  const directory = mkdtempSync(join(tmpdir(), "opencode-multireview-permissions-"));
  const parent = join(directory, "existing");
  mkdirSync(parent, { mode: 0o755 });
  try {
    chmodSync(parent, 0o755);
    ensureDatabaseDirectory(join(parent, "reviews.sqlite"));
    assert.equal(statSync(parent).mode & 0o777, 0o700);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a contended begin leaves all scope metadata unchanged", () => {
  const { directory, databasePath } = temporaryPath();
  try {
    const store = new ReviewStore({ databasePath });
    const first = store.begin({ identity: identity(), target: { kind: "custom", key: "same", label: "original" }, intent: { type: "jira", ref: "PROJ-1" } });
    const database = openDatabase({ databasePath });
    const before = database.prepare("SELECT p.root_path, p.last_seen_at AS project_seen, w.path, w.last_seen_at AS worktree_seen, r.target_label, r.base_ref, r.head_commit, r.current_intent_ref, r.updated_at FROM projects p JOIN worktrees w ON w.project_id = p.id JOIN reviews r ON r.project_id = p.id WHERE r.id = ?").get(first.reviewId);
    database.close();
    const contended = store.begin({
      identity: { ...identity(), rootPath: "/changed", worktreePath: "/changed/worktree", branch: "changed", headCommit: "changed-head", baseRef: "changed-base" },
      target: { kind: "custom", key: "same", label: "changed" },
      intent: null,
    });
    assert.equal(contended.locked, true);
    const afterDatabase = openDatabase({ databasePath });
    const after = afterDatabase.prepare("SELECT p.root_path, p.last_seen_at AS project_seen, w.path, w.last_seen_at AS worktree_seen, r.target_label, r.base_ref, r.head_commit, r.current_intent_ref, r.updated_at FROM projects p JOIN worktrees w ON w.project_id = p.id JOIN reviews r ON r.id = ?").get(first.reviewId);
    assert.deepEqual(after, before);
    assert.equal(afterDatabase.prepare("SELECT COUNT(*) AS count FROM worktrees").get().count, 1);
    afterDatabase.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("roundtrips uncertainties, blockers, complete finding properties, and latest round reads", () => {
  const { directory, databasePath } = temporaryPath();
  try {
    const store = new ReviewStore({ databasePath });
    const review = store.begin({ identity: identity(), target: target("uncertainty") });
    store.complete({
      reviewId: review.reviewId,
      roundId: review.roundId,
      fencingToken: review.fencingToken,
      validFindings: [{ ...validFinding("Blocked"), severity: "CRITICAL", category: "INTENT", bodyMarkdown: "Evidence", sourceAgents: ["testing", "correctness"], blockedByUncertaintyIds: ["2", "1"] }],
      ignoredFindings: [ignoredFinding("Ignored property")],
      uncertainties: [
        { title: "First", observedEvidence: "Observed 1", missingContext: "Missing 1", clarificationQuestion: "Question 1" },
        { title: "Second", observedEvidence: "Observed 2", missingContext: "Missing 2", clarificationQuestion: "Question 2" },
      ],
    });
    const round = store.getRound(review.reviewId);
    assert.equal(round.ordinal, 1);
    assert.deepEqual(round.uncertainties.map((item) => item.title), ["First", "Second"]);
    assert.deepEqual(round.validFindings[0], {
      disposition: "valid",
      severity: "CRITICAL",
      category: "INTENT",
      title: "Blocked",
      bodyMarkdown: "Evidence",
      sourceAgents: ["correctness", "testing"],
      blockedByUncertaintyIds: ["1", "2"],
      contentHash: round.validFindings[0].contentHash,
    });
    assert.deepEqual(round.ignoredFindings[0], {
      id: round.ignoredFindings[0].id,
      disposition: "ignored",
      severity: "LOW",
      category: "CODESTYLE",
      title: "Ignored property",
      bodyMarkdown: "The reason",
      wontfix: "Accepted trade-off",
      sourceAgents: ["codestyle"],
      blockedByUncertaintyIds: [],
      contentHash: round.ignoredFindings[0].contentHash,
    });
    const next = store.begin({ identity: identity(), target: target("uncertainty") });
    store.complete({ reviewId: next.reviewId, roundId: next.roundId, fencingToken: next.fencingToken, validFindings: [validFinding("Latest")] });
    assert.equal(store.getRound(review.reviewId).id, next.roundId);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("completion failure rolls back the round and preserves its lock", () => {
  const { directory, databasePath } = temporaryPath();
  try {
    const store = new ReviewStore({ databasePath });
    const review = store.begin({ identity: identity(), target: target("failure") });
    const database = openDatabase({ databasePath });
    database.exec("CREATE TRIGGER fail_findings BEFORE INSERT ON findings BEGIN SELECT RAISE(ABORT, 'forced completion failure'); END");
    database.close();
    assert.throws(() => store.complete({ reviewId: review.reviewId, roundId: review.roundId, fencingToken: review.fencingToken, validFindings: [validFinding()] }), /forced completion failure/);
    assert.equal(store.getRound(review.reviewId), undefined);
    assert.equal(store.inspectLock(review.reviewId).fencingToken, review.fencingToken);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persists session ownership across store restarts and prevents dispatch after completion", () => {
  const { directory, databasePath } = temporaryPath();
  try {
    const firstStore = new ReviewStore({ databasePath });
    const review = firstStore.begin({ identity: identity(), target: target("restart"), sessionID: "session-a" });
    assert.equal(firstStore.hasActiveLockOwnedBySession("session-a", review.reviewId), true);
    const restartedStore = new ReviewStore({ databasePath });
    assert.equal(restartedStore.hasActiveLockOwnedBySession("session-a", review.reviewId), true);
    assert.equal(restartedStore.hasActiveLockOwnedBySession("session-b", review.reviewId), false);
    restartedStore.complete({
      reviewId: review.reviewId,
      roundId: review.roundId,
      fencingToken: review.fencingToken,
      sessionID: "session-a",
      validFindings: [validFinding()],
    });
    const lifecycle = new PersistentReviewLifecycle({ databasePath });
    assert.equal(lifecycle.ownsActiveLock("session-a", review.reviewId), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deduplicates session-error markers and resolves them on same-session completion", () => {
  const { directory, databasePath } = temporaryPath();
  try {
    const store = new ReviewStore({ databasePath });
    const review = store.begin({ identity: identity(), target: target("marker"), sessionID: "session-a" });
    const marker = {
      sessionID: "session-a",
      reviewId: review.reviewId,
      event: "session.error",
      markerKey: "round-incomplete",
    };
    const first = store.recordIncompleteDiagnosticMarker(marker);
    const duplicate = store.recordIncompleteDiagnosticMarker(marker);
    assert.equal(duplicate.markerId, first.markerId);
    assert.equal(duplicate.deduplicated, true);
    assert.equal(store.recordIncompleteDiagnosticMarker({ ...marker, markerKey: "another-error" }).deduplicated, false);
    store.complete({
      reviewId: review.reviewId,
      roundId: review.roundId,
      fencingToken: review.fencingToken,
      sessionID: "session-a",
      validFindings: [validFinding()],
    });
    const database = openDatabase({ databasePath });
    assert.deepEqual(database.prepare("SELECT event, status FROM review_lifecycle_markers WHERE review_id = ? ORDER BY event, marker_key").all(review.reviewId).map((row) => ({ ...row })), [
      { event: "session.error", status: "resolved" },
      { event: "session.error", status: "resolved" },
    ]);
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
