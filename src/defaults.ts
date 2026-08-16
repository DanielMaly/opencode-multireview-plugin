export const REVIEWER_KEYS = ["coordinator", "codestyle", "correctness", "testing", "intent"] as const
export type ReviewerKey = (typeof REVIEWER_KEYS)[number]

export type ModelSelectionInput = string | {
  model: string
  variant?: string
}

export type ModelSelection = {
  model: string
  variant?: string
}

export type MultireviewPluginConfig = {
  models: Record<ReviewerKey, ModelSelection>
}

export type MultireviewPluginOptions = Partial<{
  configPath: string
  models: Partial<Record<ReviewerKey, ModelSelectionInput>>
}>

export const DEFAULT_CONFIG: MultireviewPluginConfig = {
  models: {
    coordinator: { model: "github-copilot/claude-opus-4.8" },
    codestyle: { model: "github-copilot/claude-sonnet-5" },
    correctness: { model: "github-copilot/gpt-5.4" },
    testing: { model: "github-copilot/gemini-3.5-flash" },
    intent: { model: "github-copilot/claude-opus-4.8" },
  },
}

export type ReviewerMetadata = {
  name: string
  description: string
  mode: "primary" | "subagent" | "all"
  promptFile: string
  hidden?: boolean
}

export const REVIEWER_REGISTRY = {
  coordinator: {
    name: "mmar_orchestrator",
    description:
      "Principal Engineer Coordinator for MMAR, multireview, and multi-model adversarial reviews of pull requests, branches, commits, uncommitted worktrees, and custom changesets.",
    mode: "all",
    hidden: false,
    promptFile: "mmar_orchestrator.md",
  },
  codestyle: {
    name: "mmar_codestyle",
    description:
      "Internal MMAR specialist lane focused exclusively on code style and readability review. Use for style-only review, linting feedback, naming feedback, or convention and clean-code questions; return results to the orchestrator and never initiate persistence.",
    mode: "subagent",
    hidden: true,
    promptFile: "mmar_codestyle.md",
  },
  correctness: {
    name: "mmar_correctness",
    description:
      "Internal MMAR specialist lane focused exclusively on correctness and security code review — covering logic soundness, edge cases, error handling, concurrency, performance, and OWASP Top 10 vulnerabilities. Return results to the orchestrator and never initiate persistence.",
    mode: "subagent",
    hidden: true,
    promptFile: "mmar_correctness.md",
  },
  testing: {
    name: "mmar_testing",
    description:
      "Internal MMAR specialist lane focused exclusively on test coverage review. Identify gaps in tests for changed code paths, return results to the orchestrator, and never initiate persistence.",
    mode: "subagent",
    hidden: true,
    promptFile: "mmar_testing.md",
  },
  intent: {
    name: "mmar_intent",
    description:
      "Internal MMAR specialist lane focused exclusively on conformance to caller-supplied plans, specifications, tickets, and decisions. Return results to the orchestrator and never initiate persistence.",
    mode: "subagent",
    hidden: true,
    promptFile: "mmar_intent.md",
  },
} as const satisfies Record<ReviewerKey, ReviewerMetadata>

export const AGENT_NAMES = Object.fromEntries(REVIEWER_KEYS.map((key) => [key, REVIEWER_REGISTRY[key].name])) as Record<ReviewerKey, string>
