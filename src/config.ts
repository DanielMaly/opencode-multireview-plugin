import { existsSync, readFileSync } from "node:fs"
import {
  DEFAULT_CONFIG,
  type MultireviewPluginConfig,
  type MultireviewPluginOptions,
  type SpecialistReviewerKey,
  type ReviewerKey,
} from "./defaults.js"
import { defaultConfigPath, resolveHomePath } from "./paths.js"

type PartialConfig = Partial<{
  models: Partial<Record<ReviewerKey, string>>
  enabled_agents: unknown
  plannotator: Partial<{ requirePlugin: boolean }>
}>

const SPECIALIST_KEYS = new Set<SpecialistReviewerKey>(["codestyle", "correctness", "testing", "intent"])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJsonConfig(path: string): PartialConfig {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!isObject(parsed)) return {}

  const models = isObject(parsed.models) ? parsed.models : undefined
  const plannotator = isObject(parsed.plannotator) ? parsed.plannotator : undefined

  return {
    models: models as Partial<Record<ReviewerKey, string>> | undefined,
    enabled_agents: parsed.enabled_agents,
    plannotator: plannotator as Partial<{ requirePlugin: boolean }> | undefined,
  }
}

function normalizeEnabledAgents(value: unknown, source: string): SpecialistReviewerKey[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    console.warn(`${source}.enabled_agents must be an array; all entries were ignored.`)
    return []
  }

  const valid: SpecialistReviewerKey[] = []
  const unknown: unknown[] = []
  for (const entry of value) {
    if (typeof entry === "string" && SPECIALIST_KEYS.has(entry as SpecialistReviewerKey)) {
      const key = entry as SpecialistReviewerKey
      if (!valid.includes(key)) valid.push(key)
    } else {
      unknown.push(entry)
    }
  }

  if (unknown.length > 0) {
    console.warn(`${source}.enabled_agents contains unknown reviewer keys; unknown entries were ignored.`)
  }
  if (value.length > 0 && valid.length === 0) {
    console.warn(`${source}.enabled_agents contained no valid reviewer keys; the specialist roster is empty.`)
  }
  return valid
}

function mergeConfig(base: MultireviewPluginConfig, override: PartialConfig | undefined): MultireviewPluginConfig {
  return {
    models: {
      ...base.models,
      ...override?.models,
    },
    enabled_agents: normalizeEnabledAgents(override?.enabled_agents, "configuration") ?? base.enabled_agents,
    plannotator: {
      ...base.plannotator,
      ...override?.plannotator,
    },
  }
}

export function loadMultireviewConfig(options: MultireviewPluginOptions = {}): MultireviewPluginConfig {
  const path = resolveHomePath(options.configPath ?? defaultConfigPath())
  const fileConfig = existsSync(path) ? parseJsonConfig(path) : undefined
  const optionConfig: PartialConfig = {
    models: options.models,
    enabled_agents: options.enabled_agents,
    plannotator: options.plannotator,
  }

  return mergeConfig(mergeConfig(DEFAULT_CONFIG, fileConfig), optionConfig)
}
