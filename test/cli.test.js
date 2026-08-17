import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { ReviewStore } from "../dist/storage/reviews.js"
import { resolveRepositoryIdentity } from "../dist/repository.js"
import { resolveDatabasePath } from "../dist/storage/path.js"

const cli = new URL("../dist/cli.js", import.meta.url)

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "opencode-multireview-cli-"))
  const home = join(directory, "home")
  const databasePath = resolveDatabasePath({ home })
  const env = { ...process.env, HOME: home }
  const identity = {
    projectKey: "cli-project",
    rootPath: "/project",
    gitCommonDir: "/project/.git",
    originUrl: "https://example.test/project.git",
    worktreePath: "/project/worktree",
    branch: "feature",
    headCommit: "head",
    isGit: true,
    baseRef: "main",
    baseCommit: "base",
  }
  const target = { kind: "custom", key: "change-set", label: "Change set" }
  const store = () => new ReviewStore({ databasePath })
  return { directory, home, databasePath, env, identity, target, store }
}

function run(args, env, options = {}) {
  return spawnSync(process.execPath, [cli.pathname, ...args], { env, encoding: "utf8", ...options })
}

test("CLI uses Commander help and rejects invalid invocations", () => {
  const help = run(["--help"], process.env)
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Manage OpenCode multireview history and skills/)
  assert.match(help.stdout, /export \[options\] <review-id>/)
  assert.match(help.stdout, /dismiss <finding-id> \[reason\]/)
  assert.match(help.stdout, /restore <finding-id>/)
  assert.match(help.stdout, /skill.*Manage installed multireview skills/)

  for (const args of [["export"], ["list", "--unknown"], ["skill", "install"], ["skill", "install", "--global", "--project"], ["unknown"]]) {
    const result = run(args, process.env)
    assert.notEqual(result.status, 0, args.join(" "))
    assert.match(result.stderr, /^Error: /, args.join(" "))
  }
})

function interactivePty(args, env, promptMarker, response, suffix = "\r") {
  const python = [
    "import os, pty, sys",
    "buffer = bytearray()",
    "answered = False",
    "def read(fd):",
    "    global answered",
    "    data = os.read(fd, 1024)",
    "    buffer.extend(data)",
    "    if not answered and sys.argv[1].encode() in buffer:",
    "        answered = True",
    "        os.write(fd, sys.argv[2].encode() + sys.argv[3].encode())",
    "    return data",
    "status = pty.spawn(sys.argv[4:], read)",
    "sys.exit(os.waitstatus_to_exitcode(status))",
  ].join("\n")
  return spawnSync("python3", ["-c", python, promptMarker, response, suffix, process.execPath, cli.pathname, ...args], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  })
}

function interactiveUnlock(reviewId, env) {
  return interactivePty(["unlock", reviewId], env, "[y/N]", "y")
}

function interactiveDismiss(findingId, env, reason = "Interactive reason") {
  return interactivePty(["dismiss", String(findingId)], env, "Reason for dismissing", reason)
}

function interactiveDismissAbort(findingId, env) {
  return interactivePty(["dismiss", String(findingId)], env, "Reason for dismissing", "\x04", "")
}

function interactiveDismissInterrupt(findingId, env) {
  return interactivePty(["dismiss", String(findingId)], env, "Reason for dismissing", "\x03", "")
}

function interactiveUnlockRace(context, reviewId) {
  const prompt = join(context.directory, "unlock-prompt.txt")
  const release = join(context.directory, "release-unlock.txt")
  const python = [
    "import os, pty, sys, time",
    "buffer = bytearray()",
    "confirmed = False",
    "def read(fd):",
    "    global confirmed",
    "    data = os.read(fd, 1024)",
    "    buffer.extend(data)",
    "    if not confirmed and b'[y/N]' in buffer:",
    "        confirmed = True",
    "        open(sys.argv[5], 'w').close()",
    "        while not os.path.exists(sys.argv[6]): time.sleep(0.01)",
    "        os.write(fd, b'y\\r')",
    "    return data",
    "sys.exit(pty.spawn(sys.argv[1:5], read))",
  ].join("\n")
  const child = spawn("python3", ["-c", python, process.execPath, cli.pathname, "unlock", reviewId, prompt, release], { env: context.env })
  let output = ""
  let replaced = false
  return new Promise((resolve, reject) => {
    const replacement = setInterval(() => {
      if (replaced || !existsSync(prompt)) return
      try {
        replaced = true
        const observed = context.store().inspectLock(reviewId)
        assert.ok(observed)
        assert.equal(context.store().unlock(reviewId, observed.fencingToken), true)
        context.store().begin({ identity: context.identity, target: context.target })
        writeFileSync(release, "replace-complete\n")
      } catch (error) {
        clearInterval(replacement)
        reject(error)
      }
    }, 5)
    child.stdout.on("data", (chunk) => {
      output += chunk.toString()
    })
    child.stderr.on("data", (chunk) => { output += chunk.toString() })
    child.on("error", reject)
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("Timed out waiting for interactive unlock"))
    }, 10_000)
    child.on("close", (status) => {
      clearInterval(replacement)
      clearTimeout(timeout)
      resolve({ status, output })
    })
  })
}

function completeReview(context) {
  const first = context.store().begin({ identity: context.identity, target: context.target, intent: { type: "jira", ref: "MMAR-7" } })
  context.store().complete({
    reviewId: first.reviewId,
    roundId: first.roundId,
    fencingToken: first.fencingToken,
    intent: { type: "jira", ref: "MMAR-7" },
    laneResults: ["correctness", "codestyle", "testing", "intent"].map((lane) => ({ lane, status: "completed" })),
    validFindings: [
      { disposition: "valid", severity: "CRITICAL", category: "CORRECTNESS", title: "Critical", bodyMarkdown: "Critical body", sourceAgents: ["correctness"] },
      { disposition: "valid", severity: "HIGH", category: "CODESTYLE", title: "Style", bodyMarkdown: "Style body", sourceAgents: ["codestyle"], blockedByUncertaintyIds: ["1"] },
      { disposition: "valid", severity: "MEDIUM", category: "TESTING", title: "Tests", bodyMarkdown: "Tests body", sourceAgents: ["testing"] },
      { disposition: "valid", severity: "LOW", category: "INTENT", title: "Intent", bodyMarkdown: "Intent body", sourceAgents: ["intent"] },
    ],
    uncertainties: [{ title: "Need context", observedEvidence: "Observed", missingContext: "Missing", clarificationQuestion: "Clarify?" }],
    ignoredFindings: [{ disposition: "ignored", severity: "LOW", category: "INTENT", title: "Wontfix", bodyMarkdown: "Ignored body", wontfix: "Accepted", sourceAgents: ["intent"] }],
  })
  return first
}

function completeDefault(store, review, extra = {}) {
  return store.complete({ ...review, ...extra, laneResults: ["correctness", "codestyle", "testing"].map((lane) => ({ lane, status: "completed" })) })
}

test("list text and JSON are stable and export selects latest or exact historical rounds", () => {
  const context = fixture()
  try {
    const first = completeReview(context)
    const second = context.store().begin({ identity: context.identity, target: context.target })
    completeDefault(context.store(), second, { validFindings: [{ disposition: "valid", severity: "LOW", category: "TESTING", title: "Latest", bodyMarkdown: "Latest body", sourceAgents: ["testing"] }] })

    const text = run(["list", "--all-projects"], context.env)
    assert.equal(text.status, 0)
    assert.match(text.stdout, new RegExp(`Review ${first.reviewId}`))
    assert.equal(text.stdout, run(["list", "--all-projects"], context.env).stdout)
    const json = run(["list", "--all-projects", "--json"], context.env)
    assert.equal(json.status, 0)
    assert.deepEqual(JSON.parse(json.stdout).map((review) => review.id), [first.reviewId])
    assert.deepEqual(JSON.parse(run(["list", "--all-projects", "--json"], context.env).stdout), JSON.parse(json.stdout))

    const latest = run(["export", first.reviewId], context.env)
    const exact = run(["export", first.reviewId, "--round", first.roundId], context.env)
    assert.equal(latest.status, 0)
    assert.equal(exact.status, 0)
    assert.match(latest.stdout, /Latest/)
    assert.match(exact.stdout, /Critical/)
    assert.equal(latest.stdout, run(["export", first.reviewId], context.env).stdout)
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("default list is repository-scoped and excludes another project", () => {
  const context = fixture()
  try {
    const repository = resolveRepositoryIdentity(process.cwd())
    const currentProjectIdentity = {
      ...repository,
      baseRef: "main",
      baseCommit: "base",
    }
    const current = context.store().begin({ identity: currentProjectIdentity, target: { kind: "custom", key: "current", label: "Current project" } })
    completeDefault(context.store(), current)
    const other = context.store().begin({ identity: context.identity, target: { kind: "custom", key: "other", label: "Other project" } })
    completeDefault(context.store(), other)

    const text = run(["list"], context.env)
    assert.equal(text.status, 0)
    assert.match(text.stdout, new RegExp(`Review ${current.reviewId}`))
    assert.doesNotMatch(text.stdout, new RegExp(other.reviewId))
    const json = run(["list", "--json"], context.env)
    assert.equal(json.status, 0)
    assert.deepEqual(JSON.parse(json.stdout).map((review) => review.id), [current.reviewId])
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("golden export covers metadata, empty sections, categories, Wontfix, uncertainties, blockers, and repeated bytes", () => {
  const context = fixture()
  try {
    const first = completeReview(context)
    const result = run(["export", first.reviewId], context.env)
    assert.equal(result.status, 0)
    assert.equal(result.stdout, [
      "# MMAR Review",
      "",
      `- Review ID: ${first.reviewId}`,
      `- Round ID: ${first.roundId}`,
      "- Target kind: custom",
      "- Target label: Change set",
      "- Base ref: main",
      "- Base commit: base",
      `- Completed at: ${context.store().getRound(first.reviewId, first.roundId).completedAt}`,
      "- Lanes: codestyle, correctness, intent, testing",
      "- Intent reference: jira:MMAR-7",
      "",
      "## Lane Outcomes",
      "",
      "- codestyle: completed",
      "- correctness: completed",
      "- intent: completed",
      "- testing: completed",
      "",
      "## Valid Findings",
      "",
      "**[CRITICAL] [CORRECTNESS] Critical**",
      "",
      "Critical body",
      "",
      "**[HIGH] [CODESTYLE] Style**",
      "",
      "Style body",
      "",
      "**Blocked by intent:** MULTIREVIEW-UNCERTAINTY-1",
      "",
      "**[MEDIUM] [TESTING] Tests**",
      "",
      "Tests body",
      "",
      "**[LOW] [INTENT] Intent**",
      "",
      "Intent body",
      "",
      "## Intent Uncertainties",
      "",
      "**[UNCERTAINTY] MULTIREVIEW-UNCERTAINTY-1: Need context**",
      "",
      "**Observed evidence:**",
      "Observed",
      "",
      "**Missing or conflicting context:**",
      "Missing",
      "",
      "**Clarification question:**",
      "Clarify?",
      "",
      "## Ignored Findings",
      "",
      "**[LOW] [INTENT] Wontfix**",
      "",
      "Ignored body",
      "",
      "**Wontfix: Accepted**",
      "",
    ].join("\n"))
    assert.equal(result.stdout, run(["export", first.reviewId], context.env).stdout)
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("export keeps multiline failure reasons on one Markdown line", () => {
  const context = fixture()
  try {
    const review = context.store().begin({ identity: context.identity, target: context.target })
    context.store().complete({
      ...review,
      laneResults: [
        { lane: "correctness", status: "failed", failureReason: " Dispatch\n\n## Forged heading\n- item " },
        { lane: "codestyle", status: "completed" },
        { lane: "testing", status: "completed" },
      ],
    })
    const result = run(["export", review.reviewId], context.env)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /- correctness: failed \(Dispatch ## Forged heading - item\)/)
    assert.doesNotMatch(result.stdout, /\n## Forged heading/)
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("empty rounds use deterministic section placeholders", () => {
  const context = fixture()
  try {
    const first = context.store().begin({ identity: context.identity, target: context.target })
    completeDefault(context.store(), first)
    const result = run(["export", first.reviewId], context.env)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /_No valid findings\._/)
    assert.match(result.stdout, /_No intent uncertainties\._/)
    assert.match(result.stdout, /_No ignored findings\._/)
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("export reports unknown review/round and preserves destination on atomic output failure", () => {
  const context = fixture()
  try {
    const unknownReview = run(["export", "missing"], context.env)
    assert.notEqual(unknownReview.status, 0)
    assert.match(unknownReview.stderr, /Unknown review: missing/)

    const first = completeReview(context)
    const unknownRound = run(["export", first.reviewId, "--round", "missing"], context.env)
    assert.notEqual(unknownRound.status, 0)
    assert.match(unknownRound.stderr, /Unknown round missing/)

    const destination = join(context.directory, "existing-directory")
    const sentinel = join(destination, "sentinel.txt")
    mkdirSync(destination)
    writeFileSync(sentinel, "destination remains intact\n")
    const failure = run(["export", first.reviewId, "--output", destination], context.env)
    assert.notEqual(failure.status, 0)
    assert.ok(existsSync(destination))
    assert.equal(readFileSync(sentinel, "utf8"), "destination remains intact\n")
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("unlock requires force when non-interactive and supports interactive confirmation", () => {
  const context = fixture()
  try {
    const first = context.store().begin({ identity: context.identity, target: context.target })
    const nonInteractive = run(["unlock", first.reviewId], context.env)
    assert.notEqual(nonInteractive.status, 0)
    assert.match(nonInteractive.stderr, /requires --force/)
    assert.ok(context.store().inspectLock(first.reviewId))

    const forced = run(["unlock", first.reviewId, "--force"], context.env)
    assert.equal(forced.status, 0)
    assert.equal(context.store().inspectLock(first.reviewId), undefined)

    const second = context.store().begin({ identity: context.identity, target: context.target })
    const interactive = interactiveUnlock(second.reviewId, context.env)
    assert.equal(interactive.status, 0, `${interactive.stdout}\n${interactive.stderr}`)
    assert.match(interactive.stdout, /Unlocked review/)
    assert.equal(context.store().inspectLock(second.reviewId), undefined)
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("fenced unlock does not remove a replaced lock", () => {
  const context = fixture()
  try {
    const first = context.store().begin({ identity: context.identity, target: context.target })
    assert.equal(context.store().unlock(first.reviewId, first.fencingToken), true)
    const replacement = context.store().begin({ identity: context.identity, target: context.target })
    assert.equal(context.store().unlock(first.reviewId, first.fencingToken), false)
    assert.equal(context.store().inspectLock(first.reviewId).fencingToken, replacement.fencingToken)
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("CLI reports a replaced lock and does not remove the replacement", async () => {
  const context = fixture()
  try {
    const first = context.store().begin({ identity: context.identity, target: context.target })
    const result = await interactiveUnlockRace(context, first.reviewId)
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /was replaced; no lock was removed/)
    assert.ok(context.store().inspectLock(first.reviewId))
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("dismiss and restore update effective exports and reject missing noninteractive reasons", () => {
  const context = fixture()
  try {
    const review = completeReview(context)
    const finding = context.store().getRound(review.reviewId).validFindings[0]
    const missing = run(["dismiss", String(finding.id)], context.env)
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /requires a reason argument when stdin or stdout is non-interactive/)

    const dismissed = run(["dismiss", String(finding.id), "  Accepted for\r\nnow  "], context.env)
    assert.equal(dismissed.status, 0, `${dismissed.stdout}\n${dismissed.stderr}`)
    assert.match(dismissed.stdout, new RegExp(`Finding ${finding.id}.*effective disposition set to ignored`))
    assert.equal(context.store().getRound(review.reviewId).ignoredFindings.find((item) => item.id === finding.id).wontfix, "Accepted for\nnow")
    assert.match(run(["export", review.reviewId], context.env).stdout, /Wontfix: Accepted for\nnow/)

    const repeated = run(["dismiss", String(finding.id), " Accepted for\nnow "], context.env)
    assert.equal(repeated.status, 0, `${repeated.stdout}\n${repeated.stderr}`)
    assert.match(repeated.stdout, /already in effective disposition ignored; idempotent no-op/)

    const restored = run(["restore", String(finding.id)], context.env)
    assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`)
    assert.match(restored.stdout, new RegExp(`Finding ${finding.id}.*effective disposition set to valid`))
    assert.equal(context.store().getRound(review.reviewId).validFindings.find((item) => item.id === finding.id).disposition, "valid")
    const restoredExport = run(["export", review.reviewId], context.env).stdout
    const validSection = restoredExport.split("## Valid Findings\n\n")[1].split("\n\n## Intent Uncertainties")[0]
    const ignoredSection = restoredExport.split("## Ignored Findings\n\n")[1]
    assert.match(validSection, /\*\*\[CRITICAL\] \[CORRECTNESS\] Critical\*\*/)
    assert.doesNotMatch(ignoredSection, /Critical|Accepted for/)

    const repeatedRestore = run(["restore", String(finding.id)], context.env)
    assert.equal(repeatedRestore.status, 0)
    assert.match(repeatedRestore.stdout, /already in effective disposition valid; idempotent no-op/)
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("dismiss prompts for a reason on a TTY", () => {
  const context = fixture()
  try {
    const review = completeReview(context)
    const finding = context.store().getRound(review.reviewId).validFindings[0]
    const result = interactiveDismiss(finding.id, context.env)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(context.store().getRound(review.reviewId).ignoredFindings.find((item) => item.id === finding.id).wontfix, "Interactive reason")
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("dismiss prompt abort rejects without mutating the finding", () => {
  const context = fixture()
  try {
    const review = completeReview(context)
    const finding = context.store().getRound(review.reviewId).validFindings[0]
    const result = interactiveDismissAbort(finding.id, context.env)
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(`${result.stdout}\n${result.stderr}`, /dismiss prompt aborted; provide a reason argument/)
    assert.equal(context.store().getRound(review.reviewId).validFindings.some((item) => item.id === finding.id), true)
    assert.equal(context.store().getRound(review.reviewId).ignoredFindings.some((item) => item.id === finding.id), false)
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("dismiss prompt interrupt rejects without mutating the finding", () => {
  const context = fixture()
  try {
    const review = completeReview(context)
    const finding = context.store().getRound(review.reviewId).validFindings[0]
    const result = interactiveDismissInterrupt(finding.id, context.env)
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(`${result.stdout}\n${result.stderr}`, /dismiss prompt aborted; provide a reason argument/)
    assert.equal(context.store().getRound(review.reviewId).validFindings.some((item) => item.id === finding.id), true)
    assert.equal(context.store().getRound(review.reviewId).ignoredFindings.some((item) => item.id === finding.id), false)
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("dismiss rejects a whitespace-only prompted reason", () => {
  const context = fixture()
  try {
    const review = completeReview(context)
    const finding = context.store().getRound(review.reviewId).validFindings[0]
    const result = interactiveDismiss(finding.id, context.env, " \t ")
    assert.match(`${result.stdout}\n${result.stderr}`, /ignored disposition requires a non-empty reason/)
    assert.equal(context.store().getRound(review.reviewId).validFindings.some((item) => item.id === finding.id), true)
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("dismiss rejects a whitespace-only positional reason", () => {
  const context = fixture()
  try {
    const review = completeReview(context)
    const finding = context.store().getRound(review.reviewId).validFindings[0]
    const result = run(["dismiss", String(finding.id), " \t "], context.env)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /ignored disposition requires a non-empty reason/)
    assert.equal(context.store().getRound(review.reviewId).validFindings.some((item) => item.id === finding.id), true)
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("dismiss accepts a dash-prefixed reason after the option delimiter", () => {
  const context = fixture()
  try {
    const review = completeReview(context)
    const finding = context.store().getRound(review.reviewId).validFindings[0]
    const result = run(["dismiss", String(finding.id), "--", "-duplicate finding"], context.env)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const dismissed = context.store().getRound(review.reviewId).ignoredFindings.find((item) => item.id === finding.id)
    assert.equal(dismissed.wontfix, "-duplicate finding")
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("dismiss and restore report actionable positive-integer errors", () => {
  const context = fixture()
  try {
    for (const args of [["dismiss", "0", "reason"], ["restore", "abc"], ["restore", "9007199254740992"]]) {
      const result = run(args, context.env)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /finding-id must be a positive safe integer/)
    }
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("disposition CLI preserves storage errors and effective state", () => {
  const context = fixture()
  try {
    const review = completeReview(context)
    const finding = context.store().getRound(review.reviewId).validFindings[0]

    const unknown = run(["restore", "999999"], context.env)
    assert.notEqual(unknown.status, 0)
    assert.match(unknown.stderr, /unknown finding 999999/)

    const active = context.store().begin({ identity: context.identity, target: context.target })
    const locked = run(["dismiss", String(finding.id), "locked"], context.env)
    assert.notEqual(locked.status, 0)
    assert.match(locked.stderr, /finding review has an active lock/)
    assert.equal(context.store().getRound(review.reviewId).validFindings.some((item) => item.id === finding.id), true)
    assert.equal(context.store().unlock(active.reviewId, active.fencingToken), true)

    const newer = context.store().begin({ identity: context.identity, target: context.target })
    completeDefault(context.store(), newer, { validFindings: [{ disposition: "valid", severity: "LOW", category: "TESTING", title: "Newer", bodyMarkdown: "Newer body", sourceAgents: ["testing"] }] })
    const stale = run(["dismiss", String(finding.id), "stale"], context.env)
    assert.notEqual(stale.status, 0)
    assert.match(stale.stderr, /finding is not in the latest completed round/)
    assert.equal(context.store().getRound(review.reviewId, review.roundId).validFindings.some((item) => item.id === finding.id), true)
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("latest export is effective while exact historical export preserves original hashes", () => {
  const context = fixture()
  try {
    const first = completeReview(context)
    const before = context.store().getRound(first.reviewId, first.roundId)
    const finding = before.validFindings[0]
    const originalContentHash = finding.contentHash
    const originalPayloadHash = before.payloadHash

    const dismissed = run(["dismiss", String(finding.id), "Keep\r\nold"], context.env)
    assert.equal(dismissed.status, 0, `${dismissed.stdout}\n${dismissed.stderr}`)
    assert.match(run(["export", first.reviewId], context.env).stdout, /Wontfix: Keep\nold/)

    const second = context.store().begin({ identity: context.identity, target: context.target })
    completeDefault(context.store(), second, { validFindings: [{ disposition: "valid", severity: "LOW", category: "TESTING", title: "Newer", bodyMarkdown: "Newer body", sourceAgents: ["testing"] }] })
    const latest = run(["export", first.reviewId], context.env)
    const historical = run(["export", first.reviewId, "--round", first.roundId], context.env)
    assert.equal(latest.status, 0)
    assert.equal(historical.status, 0)
    assert.match(latest.stdout, /Newer body/)
    assert.doesNotMatch(latest.stdout, /Keep\nold/)
    assert.match(historical.stdout, /Keep\nold/)

    const after = context.store().getRound(first.reviewId, first.roundId)
    assert.equal(after.payloadHash, originalPayloadHash)
    assert.equal(after.validFindings.find((item) => item.id === finding.id), undefined)
    assert.equal(after.ignoredFindings.find((item) => item.id === finding.id).contentHash, originalContentHash)
  } finally {
    rmSync(context.directory, { recursive: true, force: true })
  }
})

test("packed artifact contains CLI, migration, and prompt assets", () => {
  const result = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" })
  const files = JSON.parse(result).at(-1).files.map((file) => file.path)
  assert.ok(files.includes("dist/cli.js"))
  assert.ok(files.includes("assets/migrations/001_initial.sql"))
  assert.ok(files.includes("assets/migrations/004_finding_disposition_overrides.sql"))
  for (const prompt of ["mmar_orchestrator.md", "mmar_correctness.md", "mmar_codestyle.md", "mmar_testing.md", "mmar_intent.md"]) {
    assert.ok(files.includes(`assets/agents/${prompt}`))
  }
  assert.ok(!files.includes("assets/scripts/parse-review-findings.mjs"))
})
