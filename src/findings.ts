import { createHash } from "node:crypto"
import { laneRegistry } from "./lanes.js"
import type { LaneResult } from "./review.js"

export const findingSeverities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const
export type FindingSeverity = (typeof findingSeverities)[number]
// Categories are intentionally runtime-validated strings because the lane registry is extensible.
export type FindingCategory = string
export const findingDispositions = ["valid", "ignored"] as const
export type FindingDisposition = (typeof findingDispositions)[number]

export interface FindingInput {
  disposition: FindingDisposition
  severity: FindingSeverity
  category: FindingCategory
  title: string
  bodyMarkdown: string
  wontfix?: string
  sourceAgents: string[]
  blockedByUncertaintyIds?: string[]
}

export interface IntentUncertainty {
  title: string
  observedEvidence: string
  missingContext: string
  clarificationQuestion: string
}

export interface NormalizedFinding extends FindingInput {
  sourceAgents: string[]
  blockedByUncertaintyIds: string[]
  contentHash: string
}

export interface NormalizedRoundPayload {
  validFindings: NormalizedFinding[]
  ignoredFindings: NormalizedFinding[]
  uncertainties: IntentUncertainty[]
  laneResults?: LaneResult[]
}

function requiredText(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`)
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim()
}

function sortedUnique(values: string[], name: string): string[] {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${name} must contain at least one agent`)
  const normalized = values.map((value) => requiredText(name, value))
  return [...new Set(normalized)].sort()
}

function canonical(value: unknown): string {
  return JSON.stringify(value)
}

export function normalizeFinding(input: FindingInput): NormalizedFinding {
  if (!input || !findingDispositions.includes(input.disposition)) throw new Error("finding disposition is invalid")
  if (!findingSeverities.includes(input.severity)) throw new Error("finding severity is invalid")
  if (!laneRegistry.some((lane) => lane.category === input.category)) throw new Error("finding category is invalid")
  const disposition = input.disposition
  const wontfix = input.wontfix === undefined ? undefined : requiredText("finding wontfix", input.wontfix)
  if (disposition === "ignored" && !wontfix) throw new Error("ignored findings require wontfix")
  if (disposition === "valid" && wontfix !== undefined) throw new Error("valid findings cannot have wontfix")
  const normalized = {
    disposition,
    severity: input.severity,
    category: input.category,
    title: requiredText("finding title", input.title),
    bodyMarkdown: requiredText("finding bodyMarkdown", input.bodyMarkdown),
    ...(wontfix === undefined ? {} : { wontfix }),
    sourceAgents: sortedUnique(input.sourceAgents, "sourceAgents"),
    blockedByUncertaintyIds: [...new Set(input.blockedByUncertaintyIds ?? [])].sort(),
  }
  return { ...normalized, contentHash: hashFinding(normalized) }
}

export function normalizeRoundPayload(
  validFindings: FindingInput[] = [],
  ignoredFindings: FindingInput[] = [],
  uncertainties: IntentUncertainty[] = [],
): NormalizedRoundPayload {
  const valid = validFindings.map(normalizeFinding)
  const ignored = ignoredFindings.map(normalizeFinding)
  if (valid.some((finding) => finding.disposition !== "valid")) throw new Error("validFindings contain a non-valid finding")
  if (ignored.some((finding) => finding.disposition !== "ignored")) throw new Error("ignoredFindings contain a non-ignored finding")
  const normalizedUncertainties = uncertainties.map((uncertainty) => ({
    title: requiredText("uncertainty title", uncertainty.title),
    observedEvidence: requiredText("uncertainty observedEvidence", uncertainty.observedEvidence),
    missingContext: requiredText("uncertainty missingContext", uncertainty.missingContext),
    clarificationQuestion: requiredText("uncertainty clarificationQuestion", uncertainty.clarificationQuestion),
  }))
  const uncertaintyIds = new Set(normalizedUncertainties.map((_value, index) => String(index + 1)))
  for (const finding of [...valid, ...ignored]) {
    for (const id of finding.blockedByUncertaintyIds) {
      if (!uncertaintyIds.has(id)) throw new Error(`finding references unknown uncertainty ${id}`)
    }
  }
  return { validFindings: valid, ignoredFindings: ignored, uncertainties: normalizedUncertainties }
}

export function hashFinding(finding: Omit<NormalizedFinding, "contentHash">): string {
  return createHash("sha256").update(canonical(finding)).digest("hex")
}

export function hashRoundPayload(payload: NormalizedRoundPayload): string {
  return createHash("sha256").update(canonical(payload)).digest("hex")
}

export function canonicalRoundPayload(payload: NormalizedRoundPayload): string {
  return canonical(payload)
}
