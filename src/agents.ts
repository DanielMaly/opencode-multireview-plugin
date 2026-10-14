import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { REVIEWER_KEYS, REVIEWER_REGISTRY, type MultireviewPluginConfig, type ReviewerKey, type ReviewerMetadata } from "./defaults.js"
import { laneRegistry } from "./lanes.js"
import { agentsDirectory } from "./paths.js"

type AgentDefinition = {
  id: Agent.ID
  name: Agent.Name
  description: string
  mode: ReviewerMetadata["mode"]
  hidden: boolean
  model: Model.Ref
  system: string
  permissions: Array<{ action: string; resource: string; effect: "allow" | "deny" }>
}

const MMAR_TOOLS = [
  "mmar_begin",
  "mmar_complete",
  "mmar_list_reviews",
  "mmar_get_findings",
  "mmar_set_finding_disposition",
] as const

function permissionsFor(reviewer: ReviewerKey): AgentDefinition["permissions"] {
  if (reviewer === "coordinator") {
    return [
      { action: "read", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      ...laneRegistry.map(({ specialistAgent }) => ({ action: "subagent", resource: specialistAgent, effect: "allow" as const })),
      ...MMAR_TOOLS.map((action) => ({ action, resource: "*", effect: "allow" as const })),
    ]
  }

  return [
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "mmar_get_findings", resource: "*", effect: "allow" },
    ...MMAR_TOOLS.filter((action) => action !== "mmar_get_findings").map((action) => ({ action, resource: "*", effect: "deny" as const })),
  ]
}

function modelReference(model: string, variant?: string): Model.Ref {
  const parsed = Model.Ref.parse(model)
  return variant === undefined ? parsed : Model.Ref.parse(`${parsed.providerID}/${parsed.id}#${variant}`)
}

export function buildAgents(config: MultireviewPluginConfig): Record<string, AgentDefinition> {
  return Object.fromEntries(
    REVIEWER_KEYS.map((key) => {
      const metadata = REVIEWER_REGISTRY[key]
      const prompt = readFileSync(join(agentsDirectory, metadata.promptFile), "utf8")

      return [
        metadata.name,
        {
          id: Agent.ID.make(metadata.name),
          name: Agent.Name.make(metadata.name),
          description: metadata.description,
          mode: metadata.mode,
          hidden: metadata.hidden === true,
          model: modelReference(config.models[key].model, config.models[key].variant),
          system: prompt,
          permissions: permissionsFor(key),
        },
      ]
    }),
  ) as Record<string, AgentDefinition>
}
