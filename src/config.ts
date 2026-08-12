import { existsSync, readFileSync } from "node:fs"
import {
  DEFAULT_CONFIG,
  type ModelSelection,
  type ModelSelectionInput,
  type MultireviewPluginConfig,
  type MultireviewPluginOptions,
  type ReviewerKey,
  REVIEWER_KEYS,
} from "./defaults.js"
import { defaultConfigPath, resolveHomePath } from "./paths.js"

type PartialConfig = Partial<{
  profile: string
  profiles: Record<string, Partial<Record<ReviewerKey, ModelSelectionInput>>>
  models: Partial<Record<ReviewerKey, ModelSelectionInput>>
}>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function configError(path: string, message: string): Error {
  return new Error(`Invalid multireview config at ${path}: ${message}`)
}

function validateReviewerKey(path: string, key: string): asserts key is ReviewerKey {
  if (!REVIEWER_KEYS.includes(key as ReviewerKey)) {
    throw configError(path, `unknown reviewer key "${key}"`)
  }
}

function normalizeModel(path: string, value: unknown): ModelSelection {
  if (typeof value === "string") {
    if (value.trim() === "") throw configError(path, "model must be a non-empty string")
    return { model: value }
  }

  if (!isObject(value)) {
    throw configError(path, "model entry must be a non-empty string or an object")
  }

  if (typeof value.model !== "string" || value.model.trim() === "") {
    throw configError(path, "model entry must have a non-empty model string")
  }

  if (value.variant !== undefined && (typeof value.variant !== "string" || value.variant.trim() === "")) {
    throw configError(path, "variant must be a non-empty string when provided")
  }

  return value.variant === undefined ? { model: value.model } : { model: value.model, variant: value.variant }
}

function parseModels(path: string, value: unknown): Partial<Record<ReviewerKey, ModelSelection>> | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw configError(path, "must be an object")

  const models: Partial<Record<ReviewerKey, ModelSelection>> = {}
  for (const [key, model] of Object.entries(value)) {
    validateReviewerKey(`${path}.${key}`, key)
    models[key] = normalizeModel(`${path}.${key}`, model)
  }
  return models
}

function parseProfiles(path: string, value: unknown): Record<string, Partial<Record<ReviewerKey, ModelSelection>>> | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw configError(path, "must be an object")

  const profiles: Record<string, Partial<Record<ReviewerKey, ModelSelection>>> = {}
  for (const [name, profile] of Object.entries(value)) {
    if (name === "default") throw configError(`${path}.${name}`, 'the profile name "default" is reserved')
    if (!isObject(profile)) throw configError(`${path}.${name}`, "must be an object")
    profiles[name] = parseModels(`${path}.${name}`, profile) ?? {}
  }
  return profiles
}

function parseJsonConfig(path: string): PartialConfig {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!isObject(parsed)) throw configError("$", "must be an object")

  if (parsed.profile !== undefined && (typeof parsed.profile !== "string" || parsed.profile.trim() === "")) {
    throw configError("profile", "must be a non-empty string when provided")
  }

  return {
    profile: parsed.profile as string | undefined,
    profiles: parseProfiles("profiles", parsed.profiles),
    models: parseModels("models", parsed.models),
  }
}

function normalizeModels(models: Partial<Record<ReviewerKey, ModelSelectionInput>> | undefined): Partial<Record<ReviewerKey, ModelSelection>> {
  if (!models) return {}
  const normalized: Partial<Record<ReviewerKey, ModelSelection>> = {}
  for (const [key, value] of Object.entries(models)) {
    validateReviewerKey(`models.${key}`, key)
    normalized[key] = normalizeModel(`models.${key}`, value)
  }
  return normalized
}

function mergeConfig(base: MultireviewPluginConfig, override: PartialConfig | undefined): MultireviewPluginConfig {
  return {
    models: {
      ...base.models,
      ...normalizeModels(override?.models),
    },
  }
}

export function loadMultireviewConfig(options: MultireviewPluginOptions = {}): MultireviewPluginConfig {
  const path = resolveHomePath(options.configPath ?? defaultConfigPath())
  const fileConfig = existsSync(path) ? parseJsonConfig(path) : undefined
  const profileName = process.env.OPENCODE_MULTIREVIEW_PROFILE?.trim() || fileConfig?.profile || "default"
  const selectedProfile = profileName === "default" ? undefined : fileConfig?.profiles?.[profileName]

  if (profileName !== "default" && selectedProfile === undefined) {
    console.warn(`Unknown multireview profile "${profileName}"; using shipped defaults.`)
  }

  const profileConfig: PartialConfig | undefined = selectedProfile ? { models: selectedProfile } : undefined
  const fileModelsConfig: PartialConfig | undefined = fileConfig ? { models: fileConfig.models } : undefined
  const optionConfig: PartialConfig = {
    models: options.models,
  }

  return mergeConfig(mergeConfig(mergeConfig(DEFAULT_CONFIG, profileConfig), fileModelsConfig), optionConfig)
}
