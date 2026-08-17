import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import { relative } from "node:path"
import { findingDispositions, findingSeverities } from "./findings.js"
import { canonicalPath, normalizeTarget, resolveExplicitGitWorktree, resolveRepositoryIdentity, resolveReviewIdentity, targetKinds, type RepositoryIdentity, type TargetInput } from "./repository.js"
import { intentTypes, LEGACY_SESSION_ID } from "./review.js"
import type { DatabaseOptions } from "./storage/database.js"
import type { ReviewStore } from "./storage/reviews.js"
import { laneForCanonicalSpecialist, normalizeLanes } from "./lanes.js"

const z = tool.schema

const targetSchema = z.object({
  kind: z.enum(targetKinds),
  label: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).optional(),
  repository: z.string().trim().min(1).optional(),
  number: z.number().int().positive().optional(),
  branch: z.string().trim().min(1).optional(),
  commit: z.string().trim().min(1).optional(),
  changeset: z.string().trim().min(1).optional(),
}).strict()

const intentSchema = z.object({
  type: z.enum(intentTypes),
  ref: z.string().trim().min(1),
}).strict()

const findingSchema = z.object({
  disposition: z.enum(findingDispositions),
  severity: z.enum(findingSeverities),
  category: z.string().trim().min(1),
  title: z.string(),
  bodyMarkdown: z.string(),
  wontfix: z.string().optional(),
  sourceAgents: z.array(z.string()),
  blockedByUncertaintyIds: z.array(z.string()).optional(),
}).strict()

const uncertaintySchema = z.object({
  title: z.string(),
  observedEvidence: z.string(),
  missingContext: z.string(),
  clarificationQuestion: z.string(),
}).strict()

const idSchema = z.string().uuid()

const beginArgsSchema = z.object({
  target: targetSchema,
  baseRef: z.string().trim().min(1),
  requestScope: z.string().trim().min(1),
  intent: intentSchema.nullable().optional(),
  lanes: z.array(z.string()).optional(),
}).strict()

const completeArgsSchema = z.object({
  reviewId: idSchema,
  roundId: idSchema,
  fencingToken: idSchema,
  intent: intentSchema.nullable().optional(),
  laneResults: z.array(z.object({
    lane: z.string().trim().min(1),
    status: z.enum(["completed", "failed"]),
    failureReason: z.string().trim().min(1).optional(),
  }).strict()).optional(),
  validFindings: z.array(findingSchema).optional(),
  ignoredFindings: z.array(findingSchema).optional(),
  uncertainties: z.array(uncertaintySchema).optional(),
}).strict()

const listReviewsArgsSchema = z.object({
  worktreePath: z.string().trim().min(1).optional(),
}).strict()

const getFindingsArgsSchema = z.object({
  reviewId: idSchema,
  roundId: idSchema.optional(),
  worktreePath: z.string().trim().min(1).optional(),
}).strict()

const setFindingDispositionArgsSchema = z.object({
  findingId: z.number().int().positive(),
  disposition: z.enum(findingDispositions),
  reason: z.string().optional(),
}).strict()

function contextWorktree(context: ToolContext): string {
  validateToolContext(context)
  const directory = context.directory.trim()
  const worktree = context.worktree.trim()
  const relativeDirectory = relative(canonicalPath(worktree), canonicalPath(directory))
  if (relativeDirectory === ".." || relativeDirectory.startsWith("../") || relativeDirectory.startsWith("..\\")) {
    throw new Error("MMAR tool directory is outside the trusted worktree")
  }
  return canonicalPath(worktree)
}

function validateToolContext(context: ToolContext): void {
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

function trustedWriteRepository(context: ToolContext): string {
  if (context.agent !== "mmar_orchestrator") throw new Error("MMAR write tools are available only to mmar_orchestrator")
  return contextWorktree(context)
}

function authorizeDispositionRepository(context: ToolContext): RepositoryIdentity {
  validateToolContext(context)
  if (laneForCanonicalSpecialist(context.agent)) throw new Error("MMAR finding disposition is unavailable to canonical specialists")
  return resolveRepositoryIdentity(contextWorktree(context))
}

function readRepository(context: ToolContext, worktreePath: string | undefined): RepositoryIdentity {
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

  const begin = tool({
    description: "Begin a fenced MMAR review round for the trusted current worktree, selecting exact review lanes and returning the effective lanes.",
    args: beginArgsSchema.shape,
    async execute(args, context) {
      const input = beginArgsSchema.parse(args)
      const worktree = trustedWriteRepository(context)
      const identity = resolveReviewIdentity(worktree, input.baseRef)
      const target = normalizeTarget(input.target as TargetInput, identity)
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

  const complete = tool({
    description: "Complete one MMAR review round with its fenced structured snapshot and exactly one terminal lane outcome for every effective lane.",
    args: completeArgsSchema.shape,
    async execute(args, context) {
      const input = completeArgsSchema.parse(args)
      const worktree = trustedWriteRepository(context)
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

  const listReviews = tool({
    description: "List completed and in-progress MMAR reviews for the current worktree, or an explicit absolute local Git worktree root. Available to any agent with a valid context and session. Explicit paths intentionally widen model-facing read access beyond the OpenCode session root; no write or lock authority is granted.",
    args: listReviewsArgsSchema.shape,
    async execute(args, context) {
      const input = listReviewsArgsSchema.parse(args)
      const repository = readRepository(context, input.worktreePath)
      return json((await getStore()).listScoped(repository))
    },
  })

  const getFindings = tool({
    description: "Retrieve a completed MMAR review round from the current worktree, or an explicit absolute local Git worktree root. Available to any agent with a valid context and session. Explicit paths intentionally widen model-facing read access beyond the OpenCode session root; no write or lock authority is granted.",
    args: getFindingsArgsSchema.shape,
    async execute(args, context) {
      const input = getFindingsArgsSchema.parse(args)
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

  const setFindingDisposition = tool({
    description: "After an explicit user request, set a finding disposition without starting a review round. Available to any normal agent or mmar_orchestrator with valid context/session in the trusted current worktree; canonical specialists are denied. `ignored` requires a non-empty reason. `valid` forbids a reason.",
    args: setFindingDispositionArgsSchema.shape,
    async execute(args, context) {
      const input = setFindingDispositionArgsSchema.parse(args)
      const repository = authorizeDispositionRepository(context)
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
