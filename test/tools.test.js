import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createMmarTools, mmarTools } from "../dist/tools.js";
import { ReviewStore } from "../dist/storage/reviews.js";

function gitProject(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", ["-C", directory, "config", "user.email", "test@example.test"]);
  execFileSync("git", ["-C", directory, "config", "user.name", "MMAR Test"]);
  execFileSync("git", ["-C", directory, "commit", "--allow-empty", "-qm", "base"]);
  return directory;
}

function context(directory, agent = "mmar_orchestrator") {
  return { agent, directory, worktree: directory };
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

test("exposes exactly two tools and no model-controlled database or session arguments", () => {
  assert.deepEqual(Object.keys(mmarTools).sort(), ["mmar_begin", "mmar_complete"]);
  assert.deepEqual(Object.keys(mmarTools.mmar_begin.args).sort(), ["baseRef", "intent", "requestScope", "target"]);
  assert.deepEqual(Object.keys(mmarTools.mmar_complete.args).sort(), [
    "fencingToken", "ignoredFindings", "intent", "reviewId", "roundId", "uncertainties", "validFindings",
  ]);
  for (const args of [mmarTools.mmar_begin.args, mmarTools.mmar_complete.args]) {
    for (const forbidden of ["databasePath", "sql", "shell", "sessionId", "sessionID", "intentContent"]) {
      assert.equal(Object.hasOwn(args, forbidden), false);
    }
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
    const completed = parse(await tools.mmar_complete.execute({
      reviewId: first.reviewId,
      roundId: first.roundId,
      fencingToken: first.fencingToken,
      intent: { type: "jira", ref: "PROJ-1" },
      validFindings: [validFinding()],
    }, context(directory)));
    assert.deepEqual(completed, { roundId: first.roundId, idempotent: false });

    const second = parse(await tools.mmar_begin.execute(beginArgs(), context(directory)));
    assert.equal(parse(await tools.mmar_complete.execute({
      reviewId: second.reviewId,
      roundId: second.roundId,
      fencingToken: second.fencingToken,
      validFindings: [validFinding("Clears intent")],
    }, context(directory))).idempotent, false);
    assert.equal(store.list()[0].currentIntentRef, undefined);
    assert.equal(store.getRound(first.reviewId, first.roundId).intent.ref, "PROJ-1");
    assert.equal(store.getRound(first.reviewId, second.roundId).intent, undefined);

    const third = parse(await tools.mmar_begin.execute(beginArgs(), context(directory)));
    await assert.rejects(() => tools.mmar_complete.execute({
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
    await assert.rejects(() => tools.mmar_complete.execute({
      reviewId: review.reviewId, roundId: review.roundId, fencingToken: review.fencingToken, validFindings: [validFinding()],
    }, context(projectB)), /project scope/);
    await tools.mmar_complete.execute({
      reviewId: review.reviewId, roundId: review.roundId, fencingToken: review.fencingToken, validFindings: [validFinding("Project A")],
    }, context(projectA));

    const uncommitted = parse(await tools.mmar_begin.execute({ ...beginArgs(), target: { kind: "uncommitted" } }, context(projectA)));
    await assert.rejects(() => tools.mmar_complete.execute({
      reviewId: uncommitted.reviewId, roundId: uncommitted.roundId, fencingToken: uncommitted.fencingToken, validFindings: [validFinding()],
    }, { ...context(projectA), directory: otherWorktree, worktree: otherWorktree }), /trusted worktree scope/);

    const shared = parse(await tools.mmar_begin.execute(beginArgs(undefined, "shared-worktree"), context(projectA)));
    assert.equal(parse(await tools.mmar_complete.execute({
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
    await assert.rejects(() => tools.mmar_complete.execute({ reviewId: "not-an-id" }, context(directory)), /invalid|expected/i);
    await assert.rejects(() => tools.mmar_begin.execute(beginArgs(), context(directory, "mmar_correctness")), /only to mmar_orchestrator/);
    await assert.rejects(() => tools.mmar_begin.execute(beginArgs(), { agent: "mmar_orchestrator", directory: "", worktree: "" }), /directory and worktree/);
    await assert.rejects(() => tools.mmar_begin.execute(beginArgs(), { agent: "mmar_orchestrator", directory: outside, worktree: directory }), /outside/);
    const nestedResult = parse(await tools.mmar_begin.execute(beginArgs(), { agent: "mmar_orchestrator", directory: nested, worktree: directory }));
    assert.equal(nestedResult.locked, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("asserts exact orchestrator prompt contracts without claiming executable model orchestration", () => {
  const prompt = readFileSync(new URL("../assets/agents/mmar_orchestrator.md", import.meta.url), "utf8");
  const begin = prompt.indexOf("Call `mmar_begin` first");
  const read = prompt.indexOf("obtain the changeset");
  const spawn = prompt.indexOf("launch exactly these independent specialists");
  assert.ok(begin >= 0 && begin < read && begin < spawn);
  assert.match(prompt, /locked: true.*spawn nobody.*exit cleanly/s);
  assert.match(prompt, /concurrently launch exactly these independent specialists/);
  for (const specialist of ["mmar_correctness", "mmar_codestyle", "mmar_testing"]) assert.ok(prompt.includes(`- \`${specialist}\``));
  assert.match(prompt, /any intent reference was supplied.*launch `mmar_intent`.*resolution failed/s);
  assert.match(prompt, /partial.*blocked.*runtime output only/s);
  assert.match(prompt, /prior ignored entries as revalidation candidates.*not exclusions/s);
  assert.match(prompt, /After a successful begin, call `mmar_complete` exactly once/s);
  assert.doesNotMatch(prompt, /REVIEW_FINDINGS\.md|git excludes/);
  assert.doesNotMatch(readFileSync(new URL("../assets/agents/mmar_intent.md", import.meta.url), "utf8"), /\b(?:gh|Jira)\b.*(?:fetch|retriev)/is);
});
