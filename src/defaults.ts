export type SpecialistReviewerKey = "codestyle" | "correctness" | "testing" | "intent"
export type ReviewerKey = "coordinator" | SpecialistReviewerKey

export type MultireviewPluginConfig = {
  models: Record<ReviewerKey, string>
  enabled_agents: SpecialistReviewerKey[]
  plannotator: {
    requirePlugin: boolean
  }
}

export type MultireviewPluginOptions = Partial<{
  configPath: string
  models: Partial<Record<ReviewerKey, string>>
  enabled_agents: SpecialistReviewerKey[]
  plannotator: Partial<{ requirePlugin: boolean }>
}>

export const DEFAULT_CONFIG: MultireviewPluginConfig = {
  models: {
    coordinator: "github-copilot/claude-opus-4.8",
    codestyle: "github-copilot/claude-sonnet-5",
    correctness: "github-copilot/gpt-5.4",
    testing: "github-copilot/gemini-3.5-flash",
    intent: "github-copilot/claude-opus-4.8",
  },
  enabled_agents: ["codestyle", "correctness", "testing", "intent"],
  plannotator: {
    requirePlugin: true,
  },
}

export const AGENT_NAMES = {
  coordinator: "multireview",
  codestyle: "multireview_codestyle",
  correctness: "multireview_correctness",
  testing: "multireview_testing",
  intent: "multireview_intent",
} as const satisfies Record<ReviewerKey, string>

export const PLANNOTATOR_PLUGIN_NAME = "@plannotator/opencode"
