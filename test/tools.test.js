import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createMmarTools, mmarTools } from "../dist/tools.js";
import { resolveRepositoryIdentity } from "../dist/repository.js";
import { ReviewStore } from "../dist/storage/reviews.js";
import { LEGACY_SESSION_ID } from "../dist/review.js";

function gitProject(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", ["-C", directory, "config", "user.email", "test@example.test"]);
  execFileSync("git", ["-C", directory, "config", "user.name", "MMAR Test"]);
  execFileSync("git", ["-C", directory, "commit", "--allow-empty", "-qm", "base"]);
  return directory;
}

function context(directory, agent = "mmar_orchestrator", sessionID = "session-a") {
  return { agent, directory, worktree: directory, sessionID };
}

function beginArgs(intent, changeset = "review-scope") {
  return {
    target: { kind: "custom", changeset, label: "Review scope" },
    baseRef: "HEAD",
    requestScope: "test scope",
    ...(intent === undefined ? {} : { intent }),
  };
}

function validFinding(title = "Tool finding") {
  return {
    disposition: "valid",
    severity: "HIGH",
    category: "CORRECTNESS",
    title,
    bodyMarkdown: "Evidence",
    sourceAgents: ["mmar_correctness"],
  };
}

function parse(output) {
  return JSON.parse(output);
}

async function completeTool(tools, args, context) {
  const lanes = args.intent ? ["correctness", "codestyle", "testing", "intent"] : ["correctness", "codestyle", "testing"];
  const laneResults = args.reviewId && args.roundId && args.fencingToken && !Object.hasOwn(args, "laneResults")
    ? lanes.map((lane) => ({ lane, status: "completed" }))
    : undefined;
  return tools.mmar_complete.execute(laneResults ? { ...args, laneResults } : args, context);
}

test("exposes exactly four tools and no model-controlled database or session arguments", () => {
  assert.deepEqual(Object.keys(mmarTools).sort(), ["mmar_begin", "mmar_complete", "mmar_get_findings", "mmar_list_reviews"]);
  assert.match(mmarTools.mmar_begin.description, /selecting exact review lanes/);
  assert.match(mmarTools.mmar_complete.description, /exactly one terminal lane outcome/);
  assert.deepEqual(Object.keys(mmarTools.mmar_begin.args).sort(), ["baseRef", "intent", "lanes", "requestScope", "target"]);
  assert.deepEqual(Object.keys(mmarTools.mmar_complete.args).sort(), [
    "fencingToken", "ignoredFindings", "intent", "laneResults", "reviewId", "roundId", "uncertainties", "validFindings",
  ]);
  assert.deepEqual(Object.keys(mmarTools.mmar_list_reviews.args), ["worktreePath"]);
  assert.deepEqual(Object.keys(mmarTools.mmar_get_findings.args).sort(), ["reviewId", "roundId", "worktreePath"]);
  assert.equal(Object.hasOwn(mmarTools.mmar_begin.args, "worktreePath"), false);
  assert.equal(Object.hasOwn(mmarTools.mmar_complete.args, "worktreePath"), false);
  for (const args of [mmarTools.mmar_begin.args, mmarTools.mmar_complete.args, mmarTools.mmar_list_reviews.args, mmarTools.mmar_get_findings.args]) {
    for (const forbidden of ["databasePath", "sql", "shell", "sessionId", "sessionID", "intentContent"]) {
      assert.equal(Object.hasOwn(args, forbidden), false);
    }
  }
});

test("lists scoped reviews and retrieves latest or exact completed findings without lock ownership", async () => {
  const projectA = gitProject("opencode-mmar-tool-read-a-");
  const projectB = gitProject("opencode-mmar-tool-read-b-");
  const worktreeParent = mkdtempSync(join(tmpdir(), "opencode-mmar-tool-read-worktrees-"));
  const otherWorktree = join(worktreeParent, "linked");
  execFileSync("git", ["-C", projectA, "worktree", "add", "-q", "--detach", otherWorktree, "HEAD"]);
  const databasePath = join(mkdtempSync(join(tmpdir(), "opencode-mmar-tool-read-db-")), "reviews.sqlite");
  const tools = createMmarTools({ databasePath });
  try {
    assert.deepEqual(parse(await tools.mmar_list_reviews.execute({}, context(projectA))), []);
    const first = parse(await tools.mmar_begin.execute(beginArgs(undefined, "history"), context(projectA)));
    const firstRound = validFinding("First round");
    await completeTool(tools, { reviewId: first.reviewId, roundId: first.roundId, fencingToken: first.fencingToken, validFindings: [firstRound] }, context(projectA));
    const second = parse(await tools.mmar_begin.execute(beginArgs(undefined, "history"), context(projectA)));
    await completeTool(tools, { reviewId: second.reviewId, roundId: second.roundId, fencingToken: second.fencingToken, validFindings: [validFinding("Latest round")] }, context(projectA));
    mkdirSync(join(projectA, "nested"));
    const listed = parse(await tools.mmar_list_reviews.execute({}, { ...context(projectA), directory: join(projectA, "nested") }));
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, first.reviewId);
    assert.equal(listed[0].latestRoundId, second.roundId);
    const latest = parse(await tools.mmar_get_findings.execute({ reviewId: first.reviewId, worktreePath: projectA }, context(otherWorktree)));
    assert.equal(latest.id, second.roundId);
    assert.equal(latest.validFindings[0].title, "Latest round");
    const exact = parse(await tools.mmar_get_findings.execute({ reviewId: first.reviewId, roundId: first.roundId, worktreePath: projectA }, context(projectB)));
    assert.equal(exact.id, first.roundId);
    assert.equal(exact.validFindings[0].title, "First round");
    for (const agent of ["custom_agent", "mmar_correctness", "mmar_codestyle", "mmar_testing", "mmar_intent"]) {
      assert.equal(parse(await tools.mmar_list_reviews.execute({}, context(projectA, agent))).some(({ id }) => id === first.reviewId), true);
      assert.equal(parse(await tools.mmar_list_reviews.execute({ worktreePath: projectA }, context(projectB, agent))).some(({ id }) => id === first.reviewId), true);
      assert.equal(parse(await tools.mmar_get_findings.execute({ reviewId: first.reviewId }, context(projectA, agent))).id, second.roundId);
      assert.equal(parse(await tools.mmar_get_findings.execute({ reviewId: first.reviewId, worktreePath: projectA }, context(projectB, agent))).id, second.roundId);
    }
    assert.equal(new ReviewStore({ databasePath }).inspectLock(first.reviewId), undefined);

    const locked = parse(await tools.mmar_begin.execute(beginArgs(undefined, "history"), context(projectA)));
    const lockedListing = parse(await tools.mmar_list_reviews.execute({ worktreePath: projectA }, context(projectB)));
    const lockedSummary = lockedListing.find(({ id }) => id === locked.reviewId);
    assert.equal(lockedSummary.lock.acquiredAt, locked.acquiredAt);
    assert.equal(Object.hasOwn(lockedSummary.lock, "fencingToken"), false);
    const lockedFindings = parse(await tools.mmar_get_findings.execute({ reviewId: locked.reviewId, worktreePath: projectA }, context(projectB)));
    assert.equal(lockedFindings.id, second.roundId);
    assert.deepEqual(parse(await tools.mmar_list_reviews.execute({ worktreePath: projectB }, context(projectA))), []);

    const uncommitted = parse(await tools.mmar_begin.execute({ ...beginArgs(), target: { kind: "uncommitted" } }, context(projectA)));
    assert.equal(parse(await tools.mmar_list_reviews.execute({}, context(otherWorktree))).some(({ id }) => id === uncommitted.reviewId), false);
    await assert.rejects(() => tools.mmar_get_findings.execute({ reviewId: uncommitted.reviewId }, context(otherWorktree)), /trusted worktree scope/);
    await completeTool(tools, { reviewId: uncommitted.reviewId, roundId: uncommitted.roundId, fencingToken: uncommitted.fencingToken, validFindings: [validFinding("Uncommitted")] }, context(projectA));
    const selectedUncommitted = parse(await tools.mmar_get_findings.execute({ reviewId: uncommitted.reviewId, worktreePath: projectA }, context(otherWorktree)));
    assert.equal(selectedUncommitted.validFindings[0].title, "Uncommitted");
    assert.equal(parse(await tools.mmar_list_reviews.execute({ worktreePath: projectA }, context(otherWorktree))).some(({ id }) => id === uncommitted.reviewId), true);
    await assert.rejects(() => tools.mmar_get_findings.execute({ reviewId: uncommitted.reviewId, worktreePath: otherWorktree }, context(projectA)), /trusted worktree scope/);
    assert.equal(parse(await tools.mmar_list_reviews.execute({ worktreePath: otherWorktree }, context(projectA))).some(({ id }) => id === uncommitted.reviewId), false);
  } finally {
    execFileSync("git", ["-C", projectA, "worktree", "remove", "--force", otherWorktree]);
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
    rmSync(worktreeParent, { recursive: true, force: true });
  }
});

test("allows explicit reads outside context containment and resolves symlinked and linked worktree roots", async () => {
  const project = gitProject("opencode-mmar-tool-explicit-roots-");
  const worktreeParent = mkdtempSync(join(tmpdir(), "opencode-mmar-tool-explicit-worktrees-"));
  const linked = join(worktreeParent, "linked");
  const symlink = join(worktreeParent, "linked-alias");
  const outside = mkdtempSync(join(tmpdir(), "opencode-mmar-tool-explicit-context-"));
  const databasePath = join(mkdtempSync(join(tmpdir(), "opencode-mmar-tool-explicit-db-")), "reviews.sqlite");
  execFileSync("git", ["-C", project, "worktree", "add", "-q", "--detach", linked, "HEAD"]);
  symlinkSync(linked, symlink, "dir");
  const tools = createMmarTools({ databasePath });
  try {
    const linkedContext = { ...context(project), directory: outside };
    const begun = parse(await tools.mmar_begin.execute(beginArgs(undefined, "linked-history"), context(linked)));
    await completeTool(tools, {
      reviewId: begun.reviewId,
      roundId: begun.roundId,
      fencingToken: begun.fencingToken,
      validFindings: [validFinding("Linked worktree")],
    }, context(linked));

    const listed = parse(await tools.mmar_list_reviews.execute({ worktreePath: symlink }, linkedContext));
    assert.equal(listed.some(({ id }) => id === begun.reviewId), true);
    const round = parse(await tools.mmar_get_findings.execute({ reviewId: begun.reviewId, worktreePath: linked }, linkedContext));
    assert.equal(round.validFindings[0].title, "Linked worktree");

    const specialistListing = parse(await tools.mmar_list_reviews.execute({ worktreePath: linked }, { ...linkedContext, agent: "mmar_testing" }));
    assert.equal(specialistListing.some(({ id }) => id === begun.reviewId), true);
    await assert.rejects(
      () => tools.mmar_get_findings.execute({ reviewId: begun.reviewId, worktreePath: linked }, { ...linkedContext, sessionID: LEGACY_SESSION_ID }),
      /valid sessionID/,
    );
  } finally {
    execFileSync("git", ["-C", project, "worktree", "remove", "--force", linked]);
    rmSync(project, { recursive: true, force: true });
    rmSync(worktreeParent, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("does not reuse an uncommitted review for a custom target from another worktree", async () => {
  const project = gitProject("opencode-mmar-tool-kind-scope-");
  const worktreeParent = mkdtempSync(join(tmpdir(), "opencode-mmar-tool-kind-scope-worktrees-"));
  const otherWorktree = join(worktreeParent, "linked");
  execFileSync("git", ["-C", project, "worktree", "add", "-q", "--detach", otherWorktree, "HEAD"]);
  const databasePath = join(mkdtempSync(join(tmpdir(), "opencode-mmar-tool-kind-scope-db-")), "reviews.sqlite");
  const tools = createMmarTools({ databasePath });
  try {
    const uncommitted = parse(await tools.mmar_begin.execute({ ...beginArgs(), target: { kind: "uncommitted" } }, context(project)));
    await completeTool(tools, {
      reviewId: uncommitted.reviewId,
      roundId: uncommitted.roundId,
      fencingToken: uncommitted.fencingToken,
    }, context(project));

    const uncommittedKey = resolveRepositoryIdentity(project).worktreePath;
    await assert.rejects(() => tools.mmar_begin.execute({
      ...beginArgs(undefined, project),
      target: { kind: "custom", changeset: uncommittedKey, label: "Same key, different kind" },
    }, context(otherWorktree)), /review target kind does not match existing review identity/);
    assert.equal(parse(await tools.mmar_list_reviews.execute({}, context(otherWorktree))).some(({ id }) => id === uncommitted.reviewId), false);
    await assert.rejects(() => tools.mmar_get_findings.execute({ reviewId: uncommitted.reviewId }, context(otherWorktree)), /trusted worktree scope/);
    assert.equal(new ReviewStore({ databasePath }).list().find(({ id }) => id === uncommitted.reviewId).targetKind, "uncommitted");
  } finally {
    execFileSync("git", ["-C", project, "worktree", "remove", "--force", otherWorktree]);
    rmSync(project, { recursive: true, force: true });
    rmSync(worktreeParent, { recursive: true, force: true });
  }
});

test("retrieves the complete structured review round through the tool layer", async () => {
  const directory = gitProject("opencode-mmar-tool-round-projection-");
  const databasePath = join(directory, "reviews.sqlite");
  const tools = createMmarTools({ databasePath });
  try {
    const begun = parse(await tools.mmar_begin.execute({ ...beginArgs({ type: "jira", ref: "MMAR-42" }), lanes: ["correctness", "testing", "intent"] }, context(directory)));
    await completeTool(tools, {
      reviewId: begun.reviewId,
      roundId: begun.roundId,
      fencingToken: begun.fencingToken,
      intent: { type: "jira", ref: "MMAR-42" },
      laneResults: ["correctness", "testing", "intent"].map((lane) => ({ lane, status: "completed" })),
      validFindings: [{
        ...validFinding("Structured valid"),
        severity: "CRITICAL",
        sourceAgents: ["mmar_testing", "mmar_correctness"],
        blockedByUncertaintyIds: ["1"],
      }],
      ignoredFindings: [{
        disposition: "ignored",
        severity: "LOW",
        category: "INTENT",
        title: "Structured ignored",
        bodyMarkdown: "Ignored evidence",
        wontfix: "Accepted",
        sourceAgents: ["mmar_intent"],
      }],
      uncertainties: [{
        title: "Structured uncertainty",
        observedEvidence: "Observed evidence",
        missingContext: "Missing context",
        clarificationQuestion: "Clarify context?",
      }],
    }, context(directory));

    const round = parse(await tools.mmar_get_findings.execute({ reviewId: begun.reviewId }, context(directory)));
    assert.equal(round.id, begun.roundId);
    assert.equal(round.reviewId, begun.reviewId);
    assert.equal(round.ordinal, 1);
    assert.match(round.payloadHash, /^[0-9a-f]{64}$/);
    assert.match(round.completedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(round.intent, { type: "jira", ref: "MMAR-42" });
    assert.deepEqual(round.validFindings, [{
      disposition: "valid",
      severity: "CRITICAL",
      category: "CORRECTNESS",
      title: "Structured valid",
      bodyMarkdown: "Evidence",
      sourceAgents: ["mmar_correctness", "mmar_testing"],
      blockedByUncertaintyIds: ["1"],
      contentHash: round.validFindings[0].contentHash,
    }]);
    assert.match(round.validFindings[0].contentHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(round.ignoredFindings[0], {
      id: round.ignoredFindings[0].id,
      disposition: "ignored",
      severity: "LOW",
      category: "INTENT",
      title: "Structured ignored",
      bodyMarkdown: "Ignored evidence",
      wontfix: "Accepted",
      sourceAgents: ["mmar_intent"],
      blockedByUncertaintyIds: [],
      contentHash: round.ignoredFindings[0].contentHash,
    });
    assert.equal(Number.isInteger(round.ignoredFindings[0].id), true);
    assert.match(round.ignoredFindings[0].contentHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(round.uncertainties, [{
      title: "Structured uncertainty",
      observedEvidence: "Observed evidence",
      missingContext: "Missing context",
      clarificationQuestion: "Clarify context?",
    }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects invalid and out-of-scope retrievals with explicit completed-round errors", async () => {
  const projectA = gitProject("opencode-mmar-tool-read-errors-a-");
  const projectB = gitProject("opencode-mmar-tool-read-errors-b-");
  const outside = mkdtempSync(join(tmpdir(), "opencode-mmar-tool-read-errors-outside-"));
  const file = join(outside, "file");
  const nested = join(projectA, "nested");
  mkdirSync(nested);
  writeFileSync(file, "not a directory");
  const tools = createMmarTools({ databasePath: join(mkdtempSync(join(tmpdir(), "opencode-mmar-tool-read-errors-db-")), "reviews.sqlite") });
  try {
    const pending = parse(await tools.mmar_begin.execute(beginArgs(undefined, "pending"), context(projectA)));
    await assert.rejects(
      () => tools.mmar_get_findings.execute({ reviewId: pending.reviewId }, context(projectA)),
      new RegExp(`Review ${pending.reviewId} has no completed rounds`),
    );

    const completed = parse(await completeTool(tools, {
      reviewId: pending.reviewId,
      roundId: pending.roundId,
      fencingToken: pending.fencingToken,
      validFindings: [validFinding("Completed")],
    }, context(projectA)));
    assert.deepEqual(completed, { roundId: pending.roundId, idempotent: false });
    const other = parse(await tools.mmar_begin.execute(beginArgs(undefined, "other"), context(projectA)));
    await assert.rejects(
      () => tools.mmar_get_findings.execute({ reviewId: pending.reviewId, roundId: other.roundId }, context(projectA)),
      new RegExp(`Unknown round ${other.roundId} for review ${pending.reviewId}`),
    );
    await assert.rejects(
      () => tools.mmar_get_findings.execute({ reviewId: pending.reviewId, roundId: "00000000-0000-0000-0000-000000000000" }, context(projectA)),
      /Unknown round 00000000-0000-0000-0000-000000000000/,
    );
    await assert.rejects(() => tools.mmar_get_findings.execute({ reviewId: "not-a-uuid" }, context(projectA)), /invalid|expected/i);
    await assert.rejects(() => tools.mmar_get_findings.execute({ reviewId: pending.reviewId, roundId: "not-a-uuid" }, context(projectA)), /invalid|expected/i);
    await assert.rejects(() => tools.mmar_list_reviews.execute({ extra: true }, context(projectA)), /unrecognized|unknown|invalid/i);
    await assert.rejects(() => tools.mmar_get_findings.execute({ reviewId: pending.reviewId }, context(projectB)), /project scope/);
    await assert.rejects(() => tools.mmar_list_reviews.execute({}, { ...context(projectA), directory: outside }), /outside/);
    await assert.rejects(() => tools.mmar_get_findings.execute({ reviewId: pending.reviewId }, { ...context(projectA), directory: outside }), /outside/);
    await assert.rejects(() => tools.mmar_list_reviews.execute({ worktreePath: "relative/path" }, context(projectA)), /absolute/);
    await assert.rejects(() => tools.mmar_get_findings.execute({ reviewId: pending.reviewId, worktreePath: "relative/path" }, context(projectA)), /absolute/);
    await assert.rejects(() => tools.mmar_list_reviews.execute({ worktreePath: join(outside, "missing") }, context(projectA)), /does not exist/);
    await assert.rejects(() => tools.mmar_get_findings.execute({ reviewId: pending.reviewId, worktreePath: `${outside}\0` }, context(projectA)), /cannot be accessed/);
    await assert.rejects(() => tools.mmar_list_reviews.execute({ worktreePath: file }, context(projectA)), /not a directory/);
    await assert.rejects(() => tools.mmar_get_findings.execute({ reviewId: pending.reviewId, worktreePath: nested }, context(projectA)), /MMAR worktreePath must be the Git worktree root: /);
    await assert.rejects(() => tools.mmar_list_reviews.execute({ worktreePath: outside }, context(projectA)), /MMAR worktreePath is not a Git repository or worktree: /);
    for (const agent of ["custom_agent", "mmar_correctness", "mmar_codestyle", "mmar_testing", "mmar_intent"]) {
      for (const sessionID of [undefined, LEGACY_SESSION_ID]) {
        for (const execute of [
          () => tools.mmar_list_reviews.execute({ worktreePath: projectA }, { ...context(projectA, agent), sessionID }),
          () => tools.mmar_get_findings.execute({ reviewId: pending.reviewId, worktreePath: projectA }, { ...context(projectA, agent), sessionID }),
        ]) await assert.rejects(execute, /valid sessionID/);
      }
      await assert.rejects(() => tools.mmar_begin.execute(beginArgs(), context(projectA, agent)), /only to mmar_orchestrator/);
      await assert.rejects(() => completeTool(tools, {
        reviewId: pending.reviewId,
        roundId: pending.roundId,
        fencingToken: "00000000-0000-0000-0000-000000000000",
      }, context(projectA, agent)), /only to mmar_orchestrator/);
    }
  } finally {
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("executes begin, cleanly reports contention, and omits locked round/token", async () => {
  const directory = gitProject("opencode-mmar-tool-begin-");
  const databasePath = join(directory, "reviews.sqlite");
  const tools = createMmarTools({ databasePath });
  try {
    const first = parse(await tools.mmar_begin.execute(beginArgs(), context(directory)));
    assert.equal(first.locked, false);
    assert.match(first.reviewId, /^[0-9a-f-]{36}$/);
    assert.match(first.roundId, /^[0-9a-f-]{36}$/);
    assert.match(first.fencingToken, /^[0-9a-f-]{36}$/);

    const contention = parse(await tools.mmar_begin.execute(beginArgs(), context(directory)));
    assert.equal(contention.locked, true);
    assert.equal(Object.hasOwn(contention, "roundId"), false);
    assert.equal(Object.hasOwn(contention, "fencingToken"), false);
    assert.equal(contention.reviewId, first.reviewId);
    assert.equal(new ReviewStore({ databasePath }).hasActiveLockOwnedBySession("session-a", first.reviewId), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("binds completion to the trusted session and does not authorize a contender", async () => {
  const directory = gitProject("opencode-mmar-tool-session-");
  const databasePath = join(directory, "reviews.sqlite");
  const tools = createMmarTools({ databasePath });
  try {
    const first = parse(await tools.mmar_begin.execute(beginArgs(), context(directory, "mmar_orchestrator", "session-a")));
    const contender = parse(await tools.mmar_begin.execute(beginArgs(), context(directory, "mmar_orchestrator", "session-b")));
    assert.equal(contender.locked, true);
    const lifecycle = new ReviewStore({ databasePath });
    assert.equal(lifecycle.hasActiveLockOwnedBySession("session-a", first.reviewId), true);
    assert.equal(lifecycle.hasActiveLockOwnedBySession("session-b", first.reviewId), false);
    await assert.rejects(() => completeTool(tools, {
      reviewId: first.reviewId,
      roundId: first.roundId,
      fencingToken: first.fencingToken,
      validFindings: [validFinding()],
    }, context(directory, "mmar_orchestrator", "session-b")), /session ownership/);
    assert.deepEqual(await completeTool(tools, {
      reviewId: first.reviewId,
      roundId: first.roundId,
      fencingToken: first.fencingToken,
      validFindings: [validFinding()],
    }, context(directory, "mmar_orchestrator", "session-a")).then(parse), { roundId: first.roundId, idempotent: false });
    assert.equal(lifecycle.hasActiveLockOwnedBySession("session-a", first.reviewId), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("executes completion, rejects stale tokens, and preserves historical intent while clearing current intent", async () => {
  const directory = gitProject("opencode-mmar-tool-complete-");
  const databasePath = join(directory, "reviews.sqlite");
  const tools = createMmarTools({ databasePath });
  const store = new ReviewStore({ databasePath });
  try {
    const first = parse(await tools.mmar_begin.execute(beginArgs({ type: "jira", ref: "PROJ-1" }), context(directory)));
    const completed = parse(await completeTool(tools, {
      reviewId: first.reviewId,
      roundId: first.roundId,
      fencingToken: first.fencingToken,
      intent: { type: "jira", ref: "PROJ-1" },
      validFindings: [validFinding()],
    }, context(directory)));
    assert.deepEqual(completed, { roundId: first.roundId, idempotent: false });

    const second = parse(await tools.mmar_begin.execute(beginArgs(), context(directory)));
    assert.equal(parse(await completeTool(tools, {
      reviewId: second.reviewId,
      roundId: second.roundId,
      fencingToken: second.fencingToken,
      validFindings: [validFinding("Clears intent")],
    }, context(directory))).idempotent, false);
    assert.equal(store.list()[0].currentIntentRef, undefined);
    assert.equal(store.getRound(first.reviewId, first.roundId).intent.ref, "PROJ-1");
    assert.equal(store.getRound(first.reviewId, second.roundId).intent, undefined);

    const third = parse(await tools.mmar_begin.execute(beginArgs(), context(directory)));
    await assert.rejects(() => completeTool(tools, {
      reviewId: third.reviewId,
      roundId: third.roundId,
      fencingToken: "00000000-0000-0000-0000-000000000000",
      validFindings: [validFinding("Stale")],
    }, context(directory)), /stale or missing/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects completion from another project and another uncommitted worktree", async () => {
  const projectA = gitProject("opencode-mmar-tool-project-a-");
  const projectB = gitProject("opencode-mmar-tool-project-b-");
  const worktreeParent = mkdtempSync(join(tmpdir(), "opencode-mmar-tool-worktrees-"));
  const otherWorktree = join(worktreeParent, "linked");
  execFileSync("git", ["-C", projectA, "worktree", "add", "-q", "--detach", otherWorktree, "HEAD"]);
  const databasePath = join(mkdtempSync(join(tmpdir(), "opencode-mmar-tool-db-")), "reviews.sqlite");
  const tools = createMmarTools({ databasePath });
  try {
    const review = parse(await tools.mmar_begin.execute(beginArgs(), context(projectA)));
    await assert.rejects(() => completeTool(tools, {
      reviewId: review.reviewId, roundId: review.roundId, fencingToken: review.fencingToken, validFindings: [validFinding()],
    }, context(projectB)), /project scope/);
    await completeTool(tools, {
      reviewId: review.reviewId, roundId: review.roundId, fencingToken: review.fencingToken, validFindings: [validFinding("Project A")],
    }, context(projectA));

    const uncommitted = parse(await tools.mmar_begin.execute({ ...beginArgs(), target: { kind: "uncommitted" } }, context(projectA)));
    await assert.rejects(() => completeTool(tools, {
      reviewId: uncommitted.reviewId, roundId: uncommitted.roundId, fencingToken: uncommitted.fencingToken, validFindings: [validFinding()],
    }, { ...context(projectA), directory: otherWorktree, worktree: otherWorktree }), /trusted worktree scope/);

    const shared = parse(await tools.mmar_begin.execute(beginArgs(undefined, "shared-worktree"), context(projectA)));
    assert.equal(parse(await completeTool(tools, {
      reviewId: shared.reviewId, roundId: shared.roundId, fencingToken: shared.fencingToken, validFindings: [validFinding("Shared worktree")],
    }, context(otherWorktree))).idempotent, false);
  } finally {
    execFileSync("git", ["-C", projectA, "worktree", "remove", "--force", otherWorktree]);
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
    rmSync(worktreeParent, { recursive: true, force: true });
  }
});

test("rejects malformed payloads and untrusted, empty, or out-of-worktree contexts", async () => {
  const directory = gitProject("opencode-mmar-tool-guards-");
  const outside = mkdtempSync(join(tmpdir(), "opencode-mmar-tool-outside-"));
  const nested = join(directory, "nested");
  mkdirSync(nested);
  const tools = createMmarTools({ databasePath: join(directory, "reviews.sqlite") });
  try {
    await assert.rejects(() => tools.mmar_begin.execute({ target: { kind: "custom" } }, context(directory)), /invalid|expected/i);
    await assert.rejects(() => tools.mmar_begin.execute({ ...beginArgs(), worktreePath: directory }, context(directory)), /unrecognized|unknown|invalid/i);
    await assert.rejects(() => completeTool(tools, { reviewId: "not-an-id" }, context(directory)), /invalid|expected/i);
    await assert.rejects(() => completeTool(tools, { reviewId: "00000000-0000-0000-0000-000000000000", roundId: "00000000-0000-0000-0000-000000000000", fencingToken: "00000000-0000-0000-0000-000000000000", worktreePath: directory }, context(directory)), /unrecognized|unknown|invalid/i);
    await assert.rejects(() => tools.mmar_begin.execute(beginArgs(), context(directory, "mmar_correctness")), /only to mmar_orchestrator/);
    await assert.rejects(() => tools.mmar_begin.execute(beginArgs(), { agent: "mmar_orchestrator", directory: "", worktree: "", sessionID: "session-a" }), /directory and worktree/);
    await assert.rejects(() => tools.mmar_begin.execute(beginArgs(), { agent: "mmar_orchestrator", directory: outside, worktree: directory, sessionID: "session-a" }), /outside/);
    const nestedResult = parse(await tools.mmar_begin.execute(beginArgs(), { agent: "mmar_orchestrator", directory: nested, worktree: directory, sessionID: "session-a" }));
    assert.equal(nestedResult.locked, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("asserts exact orchestrator prompt contracts without claiming executable model orchestration", () => {
  const prompt = readFileSync(new URL("../assets/agents/mmar_orchestrator.md", import.meta.url), "utf8");
  const retrieval = prompt.indexOf("## Historical retrieval");
  assert.ok(prompt.includes("## Required workflow for new review requests"));
  const begin = prompt.indexOf("1. Call `mmar_begin` first");
  const read = prompt.indexOf("Obtain the changeset");
  assert.ok(retrieval >= 0 && retrieval < begin);
  assert.match(prompt, /Historical retrieval[\s\S]*Callers may use the read-only[\s\S]*this workflow does not start a review/);
  assert.ok(begin >= 0 && begin < read);
  assert.match(prompt, /returned `reviewId` and `repository\.worktreePath` as the current review scope/);
  assert.match(prompt, /including both exact values in every specialist's compact scope as `reviewId` and `worktreePath`/);
  assert.match(prompt, /locked: true.*spawn nobody.*exit cleanly/s);
  assert.match(prompt, /concurrently launch exactly the selected specialist/);
  assert.match(prompt, /effective `lanes` as authoritative/);
  assert.match(prompt, /exactly one terminal `laneResults` entry for every effective lane/);
  assert.match(prompt, /For the intent lane, give resolved content when available/);
  assert.match(prompt, /partial.*blocked.*runtime output only/s);
  assert.match(prompt, /prior ignored entries as revalidation candidates.*not exclusions/s);
  assert.match(prompt, /During an active lane, specialists may retrieve history only with the supplied current `reviewId` and `worktreePath`; they must not list or browse unrelated reviews/);
  assert.match(prompt, /After a successful begin, call `mmar_complete` exactly once/s);
  assert.match(prompt, /canonical specialist name.*short lane alias/s);
  assert.doesNotMatch(prompt, /REVIEW_FINDINGS\.md|git excludes/);
  const intentPrompt = readFileSync(new URL("../assets/agents/mmar_intent.md", import.meta.url), "utf8");
  assert.match(intentPrompt, /use `mmar_get_findings` only for that review ID and worktree path/);
  assert.match(intentPrompt, /MMAR history is not authoritative intent source material/);
  assert.match(intentPrompt, /must not be used to fetch Jira issues, Jira URLs, local files/);
  assert.match(intentPrompt, /Never retrieve external or local source material yourself/);
  assert.doesNotMatch(intentPrompt, /\b(?:may|can|should)\b[^.\n]*(?:fetch|retrieve)[^.\n]*(?:Jira|local)/is);
});
