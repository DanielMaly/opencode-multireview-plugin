import { existsSync, readFileSync } from "node:fs"
import { DEFAULT_CONFIG, type MultireviewPluginConfig, type MultireviewPluginOptions, type ReviewerKey } from "./defaults.js"
import { defaultConfigPath, resolveHomePath } from "./paths.js"

type PartialConfig = Partial<{
  models: Partial<Record<ReviewerKey, string>>
  plannotator: Partial<{ requirePlugin: boolean }>
}>

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
    plannotator: plannotator as Partial<{ requirePlugin: boolean }> | undefined,
  }
}

function mergeConfig(base: MultireviewPluginConfig, override: PartialConfig | undefined): MultireviewPluginConfig {
  return {
    models: {
      ...base.models,
      ...override?.models,
    },
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
    plannotator: options.plannotator,
  }

  return mergeConfig(mergeConfig(DEFAULT_CONFIG, fileConfig), optionConfig)
}
