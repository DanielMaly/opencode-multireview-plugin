export type LaneDefinition = {
  name: string
  specialistAgent: string
  category: string
  requiresIntent: boolean
  default: boolean
}

// Keep this registry declarative. Lifecycle and persistence code must not know the
// set of lanes; adding a lane requires its specialist, registry entry, and lane-specific tests.
export const laneRegistry: LaneDefinition[] = [
  { name: "correctness", specialistAgent: "mmar_correctness", category: "CORRECTNESS", requiresIntent: false, default: true },
  { name: "codestyle", specialistAgent: "mmar_codestyle", category: "CODESTYLE", requiresIntent: false, default: true },
  { name: "testing", specialistAgent: "mmar_testing", category: "TESTING", requiresIntent: false, default: true },
  { name: "intent", specialistAgent: "mmar_intent", category: "INTENT", requiresIntent: true, default: false },
]

export type ReviewLane = string

export function laneNames(): string[] {
  return laneRegistry.map((lane) => lane.name)
}

export function laneByName(name: string): LaneDefinition | undefined {
  return laneRegistry.find((lane) => lane.name === name)
}

export function laneForSpecialist(agent: string): LaneDefinition | undefined {
  return laneRegistry.find((lane) => lane.specialistAgent === agent)
}

export function laneForSourceAgent(agent: string): LaneDefinition | undefined {
  return laneRegistry.find((lane) => lane.specialistAgent === agent || lane.name === agent)
}

export function findingCategoriesForLanes(lanes: string[]): string[] {
  return [...new Set(lanes.flatMap((name) => {
    const lane = laneByName(name)
    return lane ? [lane.category] : []
  }))]
}

export function normalizeLanes(requested: string[] | undefined, hasIntent: boolean): string[] {
  const effective = requested === undefined
    ? laneRegistry.filter((lane) => lane.default || (hasIntent && lane.requiresIntent)).map((lane) => lane.name)
    : requested

  if (!Array.isArray(effective) || effective.length === 0) throw new Error("lanes must contain at least one lane")
  const normalized = effective.map((lane) => {
    if (typeof lane !== "string" || lane.trim() === "") throw new Error("lane must be a non-empty string")
    const value = lane.trim()
    if (!laneByName(value)) throw new Error(`unknown MMAR lane ${value}`)
    return value
  })
  if (new Set(normalized).size !== normalized.length) throw new Error("lanes must not contain duplicates")
  if (normalized.some((name) => laneByName(name)?.requiresIntent && !hasIntent)) {
    throw new Error("intent lane requires an intent reference")
  }
  const selected = new Set(normalized)
  return laneRegistry.filter((lane) => selected.has(lane.name)).map((lane) => lane.name)
}

export function validateFindingOwnership(category: string, sourceAgents: string[], lanes: string[]): void {
  const selected = lanes.map(laneByName).filter((lane): lane is LaneDefinition => lane !== undefined)
  if (!selected.some((lane) => lane.category === category)) throw new Error(`finding category ${category} is outside the requested MMAR lanes`)
  for (const sourceAgent of sourceAgents) {
    const sourceLane = laneForSourceAgent(sourceAgent)
    if (sourceLane && !lanes.includes(sourceLane.name)) throw new Error(`finding source agent ${sourceAgent} is outside the requested MMAR lanes`)
  }
}
