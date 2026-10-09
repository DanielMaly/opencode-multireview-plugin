import { relative } from "node:path"
import { findingDispositions, findingSeverities } from "./findings.js"
import { canonicalPath, normalizeTarget, resolveExplicitGitWorktree, resolveRepositoryIdentity, resolveReviewIdentity, targetKinds, type RepositoryIdentity, type TargetInput } from "./repository.js"
import { intentTypes, LEGACY_SESSION_ID } from "./review.js"
import type { DatabaseOptions } from "./storage/database.js"
import type { ReviewStore } from "./storage/reviews.js"
import { laneForCanonicalSpecialist, normalizeLanes } from "./lanes.js"

type JsonSchema = Record<string, unknown>
type ToolContext = {
  readonly sessionID: string
  readonly agent: string
  readonly directory: string
  readonly worktree: string
  readonly signal?: AbortSignal
  readonly progress?: (update: Record<string, unknown>) => Promise<void>
}
export type ToolDefinition = {
  readonly name: string
  readonly description: string
  readonly input: JsonSchema
  readonly execute: (input: unknown, context: ToolContext) => Promise<{ content: string }>
}

type Schema = JsonSchema & {
  type?: string
  enum?: readonly unknown[]
  anyOf?: readonly Schema[]
  properties?: Record<string, Schema>
  required?: readonly string[]
  items?: Schema
  additionalProperties?: boolean
  minLength?: number
  format?: string
  minimum?: number
}

const stringSchema = (extra: JsonSchema = {}): Schema => ({ type: "string", ...extra })
const objectSchema = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: "object", properties, required, additionalProperties: false,
})
const arraySchema = (items: Schema): Schema => ({ type: "array", items })
const enumSchema = (values: readonly string[]): Schema => ({ type: "string", enum: [...values] })
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] })

function parseSchema(value: unknown, schema: Schema, path = "input"): any {
  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    for (const option of schema.anyOf) {
      try { return parseSchema(value, option as Schema, path) } catch { /* try the next branch */ }
    }
    throw new Error(`${path} is invalid`)
  }
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.includes(value))) {
    throw new Error(`${path} is invalid; must be one of ${schema.enum.join(", ")}`)
  }
  if (schema.type === "null") {
    if (value !== null) throw new Error(`${path} must be null`)
    return value
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`${path} must be a string`)
    if (schema.minLength !== undefined && value.trim().length < Number(schema.minLength)) throw new Error(`${path} must be non-empty`)
    if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${path} is invalid; must be a UUID`)
    return value
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value)) || (schema.minimum !== undefined && value < Number(schema.minimum))) throw new Error(`${path} must be an expected number to be >0`)
    return value
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
    return value.map((item, index) => parseSchema(item, schema.items as Schema, `${path}[${index}]`))
  }
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`)
    const input = value as Record<string, unknown>
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) if (!(key in input)) throw new Error(`${path}.${key} is required; expected a value`)
    if (schema.additionalProperties === false) for (const key of Object.keys(input)) if (!(key in properties)) throw new Error(`${path}.${key} is unrecognized`)
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(properties)) if (key in input) output[key] = parseSchema(input[key], child, `${path}.${key}`)
    return output
  }
  return value
}

const targetSchema = objectSchema({
  kind: enumSchema(targetKinds), label: stringSchema({ minLength: 1 }), provider: stringSchema({ minLength: 1 }),
  repository: stringSchema({ minLength: 1 }), number: { type: "integer", minimum: 1 },
  branch: stringSchema({ minLength: 1 }), commit: stringSchema({ minLength: 1 }), changeset: stringSchema({ minLength: 1 }),
}, ["kind"])
const intentSchema = objectSchema({ type: enumSchema(intentTypes), ref: stringSchema({ minLength: 1 }) }, ["type", "ref"])
const findingSchema = objectSchema({
  disposition: enumSchema(findingDispositions), severity: enumSchema(findingSeverities), category: stringSchema({ minLength: 1 }),
  title: stringSchema(), bodyMarkdown: stringSchema(), wontfix: stringSchema(), sourceAgents: arraySchema(stringSchema()),
  blockedByUncertaintyIds: arraySchema(stringSchema()),
}, ["disposition", "severity", "category", "title", "bodyMarkdown", "sourceAgents"])
const uncertaintySchema = objectSchema({ title: stringSchema(), observedEvidence: stringSchema(), missingContext: stringSchema(), clarificationQuestion: stringSchema() }, ["title", "observedEvidence", "missingContext", "clarificationQuestion"])
const idSchema = stringSchema({ format: "uuid" })
const beginArgsSchema = objectSchema({ target: targetSchema, baseRef: stringSchema({ minLength: 1 }), requestScope: stringSchema({ minLength: 1 }), intent: nullable(intentSchema), lanes: arraySchema(stringSchema()), worktreePath: stringSchema({ minLength: 1 }) }, ["target", "baseRef", "requestScope"])
const completeArgsSchema = objectSchema({
  reviewId: idSchema, roundId: idSchema, fencingToken: idSchema, intent: nullable(intentSchema),
  laneResults: arraySchema(objectSchema({ lane: stringSchema({ minLength: 1 }), status: enumSchema(["completed", "failed"]), failureReason: stringSchema({ minLength: 1 }) }, ["lane", "status"])),
  validFindings: arraySchema(findingSchema), ignoredFindings: arraySchema(findingSchema), uncertainties: arraySchema(uncertaintySchema), worktreePath: stringSchema({ minLength: 1 }),
}, ["reviewId", "roundId", "fencingToken"])
const listReviewsArgsSchema = objectSchema({ worktreePath: stringSchema({ minLength: 1 }) })
const getFindingsArgsSchema = objectSchema({ reviewId: idSchema, roundId: idSchema, worktreePath: stringSchema({ minLength: 1 }) }, ["reviewId"])
const setFindingDispositionArgsSchema = objectSchema({ findingId: { type: "integer", minimum: 1 }, disposition: enumSchema(findingDispositions), reason: stringSchema(), worktreePath: stringSchema({ minLength: 1 }) }, ["findingId", "disposition"])

function defineTool(definition: { description: string; args: Schema; execute: (args: any, context: ToolContext) => Promise<string> }): Omit<ToolDefinition, "name"> {
  return {
    description: definition.description,
    input: definition.args,
    execute: async (input, context) => ({ content: await definition.execute(parseSchema(input, definition.args), context) }),
  }
}

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

function trustedWriteRepository(context: ToolContext, worktreePath: string | undefined): string {
  if (context.agent !== "mmar_orchestrator") throw new Error("MMAR write tools are available only to mmar_orchestrator")
  validateToolContext(context)
  if (worktreePath !== undefined) return resolveExplicitGitWorktree(worktreePath).worktreePath
  return contextWorktree(context)
}

function authorizeDispositionRepository(context: ToolContext, worktreePath: string | undefined): RepositoryIdentity {
  validateToolContext(context)
  if (laneForCanonicalSpecialist(context.agent)) throw new Error("MMAR finding disposition is unavailable to canonical specialists")
  if (worktreePath !== undefined) return resolveExplicitGitWorktree(worktreePath)
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

  const begin = defineTool({
    description: "Begin a fenced MMAR review round for the current worktree or an explicit absolute local Git worktree root, selecting exact review lanes and returning the effective lanes.",
    args: beginArgsSchema,
    async execute(args, context) {
      const input = parseSchema(args, beginArgsSchema)
      const worktree = trustedWriteRepository(context, input.worktreePath)
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

  const complete = defineTool({
    description: "Complete one MMAR review round in the current worktree or an explicit absolute local Git worktree root, with its fenced structured snapshot and exactly one terminal lane outcome for every effective lane.",
    args: completeArgsSchema,
    async execute(args, context) {
      const input = parseSchema(args, completeArgsSchema)
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
    description: "List completed and in-progress MMAR reviews for the current worktree, or an explicit absolute local Git worktree root. Available to any agent with a valid context and session. Explicit paths intentionally widen model-facing read access beyond the OpenCode session root; no write or lock authority is granted.",
    args: listReviewsArgsSchema,
    async execute(args, context) {
      const input = parseSchema(args, listReviewsArgsSchema)
      const repository = readRepository(context, input.worktreePath)
      return json((await getStore()).listScoped(repository))
    },
  })

  const getFindings = defineTool({
    description: "Retrieve a completed MMAR review round from the current worktree, or an explicit absolute local Git worktree root. Available to any agent with a valid context and session. Explicit paths intentionally widen model-facing read access beyond the OpenCode session root; no write or lock authority is granted.",
    args: getFindingsArgsSchema,
    async execute(args, context) {
      const input = parseSchema(args, getFindingsArgsSchema)
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
    description: "Set a finding disposition after an explicit user request without starting a review round. Normal agents and mmar_orchestrator may use this tool with a valid context and session. The tool uses the current worktree or an explicit absolute local Git worktree root. Canonical specialists cannot use it. Set `ignored` with a non-empty reason. Set `valid` without a reason.",
    args: setFindingDispositionArgsSchema,
    async execute(args, context) {
      const input = parseSchema(args, setFindingDispositionArgsSchema)
      const repository = authorizeDispositionRepository(context, input.worktreePath)
      const result = (await getStore()).setFindingDisposition({ ...input, scope: repository })
      return json(result)
    },
  })

  return Object.fromEntries(Object.entries({
    mmar_begin: begin,
    mmar_complete: complete,
    mmar_list_reviews: listReviews,
    mmar_get_findings: getFindings,
    mmar_set_finding_disposition: setFindingDisposition,
  }).map(([name, definition]) => [name, { ...definition, name }])) as Record<string, ToolDefinition>
}

export const mmarTools = createMmarTools()
