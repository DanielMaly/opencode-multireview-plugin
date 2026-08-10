import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AGENT_NAMES, type MultireviewPluginConfig, type ReviewerKey } from "./defaults.js"
import { agentsDirectory } from "./paths.js"

type AgentMode = "primary" | "subagent" | "all"

type AgentDefinition = {
  description: string
  mode: AgentMode
  model: string
  variant?: string
  prompt: string
  permission: Record<string, "allow" | "deny">
  tools: Record<string, boolean>
}

const AGENT_METADATA: Record<ReviewerKey, { description: string; mode: AgentMode; promptFile: string }> = {
  coordinator: {
    description:
      "Principal Engineer Coordinator for MMAR, multireview, and multi-model adversarial reviews of pull requests, branches, commits, uncommitted worktrees, and custom changesets.",
    mode: "all",
    promptFile: "mmar_orchestrator.md",
  },
  codestyle: {
    description:
      "Internal MMAR specialist lane focused exclusively on code style and readability review. Use for style-only review, linting feedback, naming feedback, or convention and clean-code questions; return results to the orchestrator and never initiate persistence.",
    mode: "subagent",
    promptFile: "mmar_codestyle.md",
  },
  correctness: {
    description:
      "Internal MMAR specialist lane focused exclusively on correctness and security code review — covering logic soundness, edge cases, error handling, concurrency, performance, and OWASP Top 10 vulnerabilities. Return results to the orchestrator and never initiate persistence.",
    mode: "subagent",
    promptFile: "mmar_correctness.md",
  },
  testing: {
    description:
      "Internal MMAR specialist lane focused exclusively on test coverage review. Identify gaps in tests for changed code paths, return results to the orchestrator, and never initiate persistence.",
    mode: "subagent",
    promptFile: "mmar_testing.md",
  },
  intent: {
    description:
      "Internal MMAR specialist lane focused exclusively on conformance to caller-supplied plans, specifications, tickets, and decisions. Return results to the orchestrator and never initiate persistence.",
    mode: "subagent",
    promptFile: "mmar_intent.md",
  },
} as const

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
  mmar_list_reviews: false,
  mmar_get_findings: false,
} as const

export function buildAgents(config: MultireviewPluginConfig): Record<string, AgentDefinition> {
  return Object.fromEntries(
    (Object.keys(AGENT_NAMES) as ReviewerKey[]).map((key) => {
      const metadata = AGENT_METADATA[key]
      const permission = key === "coordinator" ? COORDINATOR_PERMISSION : REVIEWER_PERMISSION
      const tools = key === "coordinator" ? COORDINATOR_TOOLS : REVIEWER_TOOLS
      const prompt = readFileSync(join(agentsDirectory, metadata.promptFile), "utf8")

      return [
        AGENT_NAMES[key],
        {
          description: metadata.description,
          mode: metadata.mode,
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
