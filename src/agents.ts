import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AGENT_NAMES, type MultireviewPluginConfig, type ReviewerKey } from "./defaults.js"
import { agentsDirectory } from "./paths.js"

type AgentDefinition = {
  description: string
  mode: "primary" | "subagent"
  model: string
  prompt: string
  permission: Record<string, "allow" | "deny">
}

const AGENT_METADATA = {
  coordinator: {
    description: "Principal Engineer Coordinator for adversarial, multi-model code review.",
    mode: "primary",
    promptFile: "multireview.md",
  },
  codestyle: {
    description:
      "Senior Engineer focused exclusively on code style and readability review. Use when the user wants a style-only code review, linting feedback, naming feedback, or wants to know if their code follows conventions and clean code principles.",
    mode: "subagent",
    promptFile: "multireview_codestyle.md",
  },
  correctness: {
    description:
      "Senior Engineer focused exclusively on correctness and security code review — covering logic soundness, edge cases, error handling, concurrency, performance, and OWASP Top 10 vulnerabilities. Use when the user wants a correctness-only or security-only review, wants to find bugs, race conditions, unhandled errors, or security vulnerabilities, or explicitly wants to exclude style/readability feedback.",
    mode: "subagent",
    promptFile: "multireview_correctness.md",
  },
  testing: {
    description:
      "Senior Engineer focused exclusively on test coverage review. Use when the user wants to review test coverage for a changeset, wants to know if their unit tests are sufficient, or wants to identify gaps in testing for new or modified code paths.",
    mode: "subagent",
    promptFile: "multireview_testing.md",
  },
} as const satisfies Record<ReviewerKey, { description: string; mode: "primary" | "subagent"; promptFile: string }>

const COORDINATOR_PERMISSION = {
  read: "allow",
  edit: "allow",
  task: "allow",
  bash: "deny",
} as const

const REVIEWER_PERMISSION = {
  read: "allow",
  glob: "allow",
  grep: "allow",
  bash: "allow",
  edit: "deny",
} as const

export function buildAgents(config: MultireviewPluginConfig): Record<string, AgentDefinition> {
  return Object.fromEntries(
    (Object.keys(AGENT_NAMES) as ReviewerKey[]).map((key) => {
      const metadata = AGENT_METADATA[key]
      const permission = key === "coordinator" ? COORDINATOR_PERMISSION : REVIEWER_PERMISSION
      const prompt = readFileSync(join(agentsDirectory, metadata.promptFile), "utf8")

      return [
        AGENT_NAMES[key],
        {
          description: metadata.description,
          mode: metadata.mode,
          model: config.models[key],
          prompt,
          permission,
        },
      ]
    }),
  ) as Record<string, AgentDefinition>
}
