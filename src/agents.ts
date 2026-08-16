import { readFileSync } from "node:fs"
import { join } from "node:path"
import { REVIEWER_KEYS, REVIEWER_REGISTRY, type MultireviewPluginConfig, type ReviewerKey, type ReviewerMetadata } from "./defaults.js"
import { agentsDirectory } from "./paths.js"

type AgentDefinition = {
  description: string
  mode: ReviewerMetadata["mode"]
  model: string
  variant?: string
  prompt: string
  permission: Record<string, unknown>
  tools: Record<string, boolean>
  hidden?: boolean
}

const COORDINATOR_PERMISSION = {
  read: "allow",
  task: "allow",
  bash: "deny",
} as const

const COORDINATOR_TOOLS = {
  mmar_begin: true,
  mmar_complete: true,
  mmar_list_reviews: true,
  mmar_get_findings: true,
} as const

const REVIEWER_PERMISSION = {
  read: "allow",
  glob: "allow",
  grep: "allow",
  bash: "allow",
  edit: "deny",
} as const

const REVIEWER_TOOLS = {
  mmar_begin: false,
  mmar_complete: false,
  mmar_list_reviews: true,
  mmar_get_findings: true,
} as const

export function buildAgents(config: MultireviewPluginConfig): Record<string, AgentDefinition> {
  return Object.fromEntries(
    REVIEWER_KEYS.map((key) => {
      const metadata = REVIEWER_REGISTRY[key]
      const permission = key === "coordinator" ? COORDINATOR_PERMISSION : REVIEWER_PERMISSION
      const tools = key === "coordinator" ? COORDINATOR_TOOLS : REVIEWER_TOOLS
      const prompt = readFileSync(join(agentsDirectory, metadata.promptFile), "utf8")

      return [
        metadata.name,
        {
          description: metadata.description,
          mode: metadata.mode,
          ...(metadata.hidden === true ? { hidden: true } : {}),
          model: config.models[key].model,
          ...(config.models[key].variant === undefined ? {} : { variant: config.models[key].variant }),
          prompt,
          permission,
          tools,
        },
      ]
    }),
  ) as Record<string, AgentDefinition>
}
