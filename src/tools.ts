import { relative } from "node:path"
import { Schema } from "effect"
import { findingDispositions, findingSeverities } from "./findings.js"
import { canonicalPath, normalizeTarget, resolveExplicitGitWorktree, resolveRepositoryIdentity, resolveReviewIdentity, targetKinds, type RepositoryIdentity } from "./repository.js"
import { intentTypes, LEGACY_SESSION_ID } from "./review.js"
import type { DatabaseOptions } from "./storage/database.js"
import type { ReviewStore } from "./storage/reviews.js"
import { laneForCanonicalSpecialist, normalizeLanes } from "./lanes.js"

export type MmarToolContext = {
  readonly sessionID: string
  readonly agent: string
  readonly directory: string
  readonly worktree: string
}
type ToolInputSchema = Schema.Struct<Schema.Struct.Fields> & Schema.Codec<unknown, unknown, never, never>
export type ToolDefinition = {
  readonly name: string
  readonly description: string
  readonly options: { readonly codemode: false }
  readonly input: ToolInputSchema
  readonly execute: (input: unknown, context: MmarToolContext) => Promise<{ content: string }>
}

const NonEmpty = Schema.Trim.check(Schema.isNonEmpty())
const Id = Schema.String.check(Schema.isUUID())
const PositiveInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
const optionalKey = Schema.optionalKey
const target = Schema.Struct({
  kind: Schema.Literals(targetKinds),
  label: optionalKey(NonEmpty),
  provider: optionalKey(NonEmpty),
  repository: optionalKey(NonEmpty),
  number: optionalKey(PositiveInt),
  branch: optionalKey(NonEmpty),
  commit: optionalKey(NonEmpty),
  changeset: optionalKey(NonEmpty),
})
const intent = optionalKey(Schema.NullOr(Schema.Struct({
  type: Schema.Literals(intentTypes),
  ref: NonEmpty,
})))
const finding = Schema.Struct({
  disposition: Schema.Literals(findingDispositions),
  severity: Schema.Literals(findingSeverities),
  category: NonEmpty,
  title: Schema.String,
  bodyMarkdown: Schema.String,
  wontfix: optionalKey(Schema.String),
  sourceAgents: Schema.mutable(Schema.Array(Schema.String)),
  blockedByUncertaintyIds: optionalKey(Schema.mutable(Schema.Array(Schema.String))),
})
const uncertainty = Schema.Struct({
  title: Schema.String,
  observedEvidence: Schema.String,
  missingContext: Schema.String,
  clarificationQuestion: Schema.String,
})
const laneResult = Schema.Struct({
  lane: NonEmpty,
  status: Schema.Literals(["completed", "failed"]),
  failureReason: optionalKey(NonEmpty),
})
const worktreePath = optionalKey(NonEmpty)
const beginArgs = Schema.Struct({
  target,
  baseRef: NonEmpty,
  requestScope: NonEmpty,
  intent,
  lanes: optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  worktreePath,
})
const completeArgs = Schema.Struct({
  reviewId: Id,
  roundId: Id,
  fencingToken: Id,
  intent,
  laneResults: optionalKey(Schema.mutable(Schema.Array(laneResult))),
  validFindings: optionalKey(Schema.mutable(Schema.Array(finding))),
  ignoredFindings: optionalKey(Schema.mutable(Schema.Array(finding))),
  uncertainties: optionalKey(Schema.mutable(Schema.Array(uncertainty))),
  worktreePath,
})
const listReviewsArgs = Schema.Struct({
  worktreePath,
})
const getFindingsArgs = Schema.Struct({
  reviewId: Id,
  roundId: optionalKey(Id),
  worktreePath,
})
const setFindingDispositionArgs = Schema.Struct({
  findingId: PositiveInt,
  disposition: Schema.Literals(findingDispositions),
  reason: optionalKey(Schema.String),
  worktreePath,
})

function defineTool<S extends Schema.Struct<Schema.Struct.Fields> & Schema.Codec<unknown, unknown, never, never>>(definition: {
  name: string
  description: string
  args: S
  execute: (args: S["Type"], context: MmarToolContext) => Promise<string>
}): ToolDefinition {
  const decode = Schema.decodeUnknownSync(definition.args, { onExcessProperty: "error" })
  return {
    name: definition.name,
    description: definition.description,
    options: { codemode: false },
    input: definition.args,
    execute: async (input, context) => ({
      content: await definition.execute(decode(input), context),
    }),
  }
}

function contextWorktree(context: MmarToolContext): string {
  validateToolContext(context)
  const directory = context.directory.trim()
  const worktree = context.worktree.trim()
  const relativeDirectory = relative(canonicalPath(worktree), canonicalPath(directory))
  if (relativeDirectory === ".." || relativeDirectory.startsWith("../") || relativeDirectory.startsWith("..\\")) {
    throw new Error("MMAR tool directory is outside the trusted worktree")
  }
  return canonicalPath(worktree)
}

function validateToolContext(context: MmarToolContext): void {
  const agent = context.agent
  const directory = context.directory.trim()
  const worktree = context.worktree.trim()
  const isMissingAgent = typeof agent !== "string" || agent.length === 0
  const isPaddedAgent = typeof agent === "string" && agent.trim() !== agent
  const hasInvalidAgent = isMissingAgent || isPaddedAgent
  if (hasInvalidAgent) throw new Error("MMAR tool context must include an unpadded agent identity")
  if (!directory || !worktree) throw new Error("MMAR tool context must include directory and worktree")
  const sessionID = context.sessionID?.trim()
  if (!sessionID || sessionID === LEGACY_SESSION_ID) throw new Error("MMAR tool context must include a valid sessionID")
}

function trustedWriteRepository(context: MmarToolContext, worktreePath: string | undefined): string {
  if (context.agent !== "mmar_orchestrator") throw new Error("MMAR write tools are available only to mmar_orchestrator")
  validateToolContext(context)
  if (worktreePath !== undefined) return resolveExplicitGitWorktree(worktreePath).worktreePath
  return contextWorktree(context)
}

function authorizeDispositionRepository(context: MmarToolContext, worktreePath: string | undefined): RepositoryIdentity {
  validateToolContext(context)
  if (laneForCanonicalSpecialist(context.agent)) throw new Error("MMAR finding disposition is unavailable to canonical specialists")
  if (worktreePath !== undefined) return resolveExplicitGitWorktree(worktreePath)
  return resolveRepositoryIdentity(contextWorktree(context))
}

function readRepository(context: MmarToolContext, worktreePath: string | undefined): RepositoryIdentity {
  if (worktreePath === undefined) {
    const path = contextWorktree(context)
    return resolveRepositoryIdentity(path)
  }
  validateToolContext(context)
  return resolveExplicitGitWorktree(worktreePath)
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

export function createMmarTools(databaseOptions: DatabaseOptions = {}): Record<string, ToolDefinition> {
  let store: ReviewStore | undefined
  const getStore = async (): Promise<ReviewStore> => {
    if (!store) {
      const { ReviewStore: ReviewStoreClass } = await import("./storage/reviews.js")
      store = new ReviewStoreClass(databaseOptions)
    }
    return store
  }

  const begin = defineTool({
    name: "mmar_begin",
    description: "Begin a fenced MMAR review round for the current worktree or an explicit absolute local Git worktree root, selecting exact review lanes and returning the effective lanes.",
    args: beginArgs,
    async execute(input, context) {
      const worktree = trustedWriteRepository(context, input.worktreePath)
      const identity = resolveReviewIdentity(worktree, input.baseRef)
      const target = normalizeTarget(input.target, identity)
      const lanes = normalizeLanes(input.lanes, input.intent !== undefined && input.intent !== null)
      const review = (await getStore()).begin({ identity, target, intent: input.intent ?? undefined, lanes, sessionID: context.sessionID })
      return json({
        ...review,
        requestScope: input.requestScope,
        target,
        baseRef: identity.baseRef,
        baseCommit: identity.baseCommit,
        repository: {
          rootPath: identity.rootPath,
          worktreePath: identity.worktreePath,
          branch: identity.branch,
          headCommit: identity.headCommit,
        },
      })
    },
  })

  const complete = defineTool({
    name: "mmar_complete",
    description: "Complete one MMAR review round in the current worktree or an explicit absolute local Git worktree root, with its fenced structured snapshot and exactly one terminal lane outcome for every effective lane.",
    args: completeArgs,
    async execute(input, context) {
      const worktree = trustedWriteRepository(context, input.worktreePath)
      const repository = resolveRepositoryIdentity(worktree)
      const reviewStore = await getStore()
      reviewStore.assertReviewScope(input.reviewId, repository)
      const completion = reviewStore.complete({
        reviewId: input.reviewId,
        roundId: input.roundId,
        fencingToken: input.fencingToken,
        sessionID: context.sessionID,
        intent: input.intent ?? undefined,
        laneResults: input.laneResults,
        validFindings: input.validFindings ?? [],
        ignoredFindings: input.ignoredFindings ?? [],
        uncertainties: input.uncertainties ?? [],
      })
      return json(completion)
    },
  })

  const listReviews = defineTool({
    name: "mmar_list_reviews",
    description: "List completed and in-progress MMAR reviews for the current worktree, or an explicit absolute local Git worktree root. Available to any agent with a valid context and session. Explicit paths intentionally widen model-facing read access beyond the OpenCode session root; no write or lock authority is granted.",
    args: listReviewsArgs,
    async execute(input, context) {
      const repository = readRepository(context, input.worktreePath)
      return json((await getStore()).listScoped(repository))
    },
  })

  const getFindings = defineTool({
    name: "mmar_get_findings",
    description: "Retrieve a completed MMAR review round from the current worktree, or an explicit absolute local Git worktree root. Available to any agent with a valid context and session. Explicit paths intentionally widen model-facing read access beyond the OpenCode session root; no write or lock authority is granted.",
    args: getFindingsArgs,
    async execute(input, context) {
      const repository = readRepository(context, input.worktreePath)
      const reviewStore = await getStore()
      reviewStore.assertReviewScope(input.reviewId, repository)
      const round = reviewStore.getRound(input.reviewId, input.roundId)
      if (!round) {
        if (input.roundId) throw new Error(`Unknown round ${input.roundId} for review ${input.reviewId}`)
        throw new Error(`Review ${input.reviewId} has no completed rounds`)
      }
      return json(round)
    },
  })

  const setFindingDisposition = defineTool({
    name: "mmar_set_finding_disposition",
    description: "Set a finding disposition after an explicit user request without starting a review round. Normal agents and mmar_orchestrator may use this tool with a valid context and session. The tool uses the current worktree or an explicit absolute local Git worktree root. Canonical specialists cannot use it. Set `ignored` with a non-empty reason. Set `valid` without a reason.",
    args: setFindingDispositionArgs,
    async execute(input, context) {
      const repository = authorizeDispositionRepository(context, input.worktreePath)
      const result = (await getStore()).setFindingDisposition({ ...input, scope: repository })
      return json(result)
    },
  })

  return {
    mmar_begin: begin,
    mmar_complete: complete,
    mmar_list_reviews: listReviews,
    mmar_get_findings: getFindings,
    mmar_set_finding_disposition: setFindingDisposition,
  }
}

export const mmarTools = createMmarTools()
