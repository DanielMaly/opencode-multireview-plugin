import { realpathSync } from "node:fs"
import { relative, resolve } from "node:path"
import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import { normalizeTarget, resolveRepositoryIdentity, resolveReviewIdentity, type TargetInput } from "./repository.js"
import type { DatabaseOptions } from "./storage/database.js"
import type { ReviewStore } from "./storage/reviews.js"

const z = tool.schema

const targetSchema = z.object({
  kind: z.enum(["pull_request", "branch", "commit", "uncommitted", "custom"]),
  label: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).optional(),
  repository: z.string().trim().min(1).optional(),
  number: z.number().int().positive().optional(),
  branch: z.string().trim().min(1).optional(),
  commit: z.string().trim().min(1).optional(),
  changeset: z.string().trim().min(1).optional(),
}).strict()

const intentSchema = z.object({
  type: z.enum(["jira", "local_file"]),
  ref: z.string().trim().min(1),
}).strict()

const findingSchema = z.object({
  disposition: z.enum(["valid", "ignored"]),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
  category: z.enum(["CORRECTNESS", "CODESTYLE", "TESTING", "INTENT"]),
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
}).strict()

const completeArgsSchema = z.object({
  reviewId: idSchema,
  roundId: idSchema,
  fencingToken: idSchema,
  intent: intentSchema.nullable().optional(),
  validFindings: z.array(findingSchema).optional(),
  ignoredFindings: z.array(findingSchema).optional(),
  uncertainties: z.array(uncertaintySchema).optional(),
}).strict()

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

function trustedWorktree(context: ToolContext): string {
  if (context.agent !== "mmar_orchestrator") throw new Error("MMAR persistence tools are available only to mmar_orchestrator")
  const directory = context.directory.trim()
  const worktree = context.worktree.trim()
  if (!directory || !worktree) throw new Error("MMAR tool context must include directory and worktree")
  const sessionID = context.sessionID?.trim()
  if (!sessionID || sessionID === "__legacy_unbound__") throw new Error("MMAR tool context must include a valid sessionID")
  const relativeDirectory = relative(canonicalPath(worktree), canonicalPath(directory))
  if (relativeDirectory === ".." || relativeDirectory.startsWith("../") || relativeDirectory.startsWith("..\\")) {
    throw new Error("MMAR tool directory is outside the trusted worktree")
  }
  return canonicalPath(worktree)
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
    description: "Begin a fenced MMAR review round for the trusted current worktree.",
    args: beginArgsSchema.shape,
    async execute(args, context) {
      const input = beginArgsSchema.parse(args)
      const worktree = trustedWorktree(context)
      const identity = resolveReviewIdentity(worktree, input.baseRef)
      const target = normalizeTarget(input.target as TargetInput, identity)
      const review = (await getStore()).begin({ identity, target, intent: input.intent ?? undefined, sessionID: context.sessionID })
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
    description: "Complete one MMAR review round with its fenced structured snapshot.",
    args: completeArgsSchema.shape,
    async execute(args, context) {
      const input = completeArgsSchema.parse(args)
      const worktree = trustedWorktree(context)
      const repository = resolveRepositoryIdentity(worktree)
      const reviewStore = await getStore()
      reviewStore.assertReviewScope(input.reviewId, repository)
      const completion = reviewStore.complete({
        reviewId: input.reviewId,
        roundId: input.roundId,
        fencingToken: input.fencingToken,
        sessionID: context.sessionID,
        intent: input.intent ?? undefined,
        validFindings: input.validFindings ?? [],
        ignoredFindings: input.ignoredFindings ?? [],
        uncertainties: input.uncertainties ?? [],
      })
      return json(completion)
    },
  })

  return {
    mmar_begin: begin,
    mmar_complete: complete,
  }
}

export const mmarTools = createMmarTools()
