export type ReviewerKey = "coordinator" | "codestyle" | "correctness" | "testing" | "intent"

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

export const AGENT_NAMES = {
  coordinator: "mmar_orchestrator",
  codestyle: "mmar_codestyle",
  correctness: "mmar_correctness",
  testing: "mmar_testing",
  intent: "mmar_intent",
} as const satisfies Record<ReviewerKey, string>
