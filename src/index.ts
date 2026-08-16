import type { Config as OpenCodeConfig, Plugin } from "@opencode-ai/plugin"
import { buildAgents } from "./agents.js"
import { loadMultireviewConfig } from "./config.js"
import type { MultireviewPluginOptions } from "./defaults.js"
import { ReviewLifecycleHooks } from "./lifecycleHooks.js"
import { appendBundledSkillPath, type OpenCodeConfigShape } from "./skillDiscovery.js"
import { PersistentReviewLifecycle, type ReviewLifecycle } from "./storage/lifecycle.js"
import { mmarTools } from "./tools.js"
import { laneRegistry } from "./lanes.js"
import { REVIEWER_REGISTRY } from "./defaults.js"

type PermissionAction = "ask" | "allow" | "deny"
type PermissionRules = Record<string, PermissionAction>
type PluginConfigShape = OpenCodeConfig & {
  permission?: PermissionAction | Record<string, unknown>
  subagent_depth?: number
}

const orchestratorName = REVIEWER_REGISTRY.coordinator.name

function specialistNames(): string[] {
  return laneRegistry.map((lane) => lane.specialistAgent)
}

function taskRules(task: unknown, names: string[]): PermissionRules {
  const denials = Object.fromEntries(names.map((name) => [name, "deny" as const]))
  if (typeof task === "string") return { "*": task as PermissionAction, ...denials }
  if (task && typeof task === "object" && !Array.isArray(task)) {
    const preserved = Object.fromEntries(Object.entries(task).filter(([key]) => !names.includes(key))) as PermissionRules
    return { ...preserved, ...denials }
  }
  return denials
}

function restrictTopLevelTask(config: PluginConfigShape, names: string[]): void {
  if (typeof config.permission === "string") {
    config.permission = { "*": config.permission, task: taskRules(config.permission, names) }
    return
  }
  const permission = config.permission && typeof config.permission === "object" ? config.permission : {}
  config.permission = { ...permission, task: taskRules(permission.task, names) }
}

function restrictAgentTaskOverrides(config: PluginConfigShape, names: string[]): void {
  for (const [name, value] of Object.entries(config.agent ?? {})) {
    if (name === orchestratorName || !value || typeof value !== "object" || Array.isArray(value)) continue
    const agent = value as Record<string, unknown>
    const permission = agent.permission
    if (typeof permission === "string") {
      agent.permission = { "*": permission, task: taskRules(permission, names) }
      continue
    }
    if (!permission || typeof permission !== "object" || Array.isArray(permission)) continue
    const rules = permission as Record<string, unknown>
    if (!Object.hasOwn(rules, "task")) continue
    agent.permission = { ...rules, task: taskRules(rules.task, names) }
  }
}

function restrictOrchestrator(config: PluginConfigShape, names: string[]): void {
  const agent = config.agent?.[orchestratorName] as Record<string, unknown> | undefined
  if (!agent) return
  const permission = typeof agent.permission === "string"
    ? { "*": agent.permission }
    : agent.permission && typeof agent.permission === "object" && !Array.isArray(agent.permission)
      ? agent.permission as Record<string, unknown>
      : {}
  agent.permission = { ...permission, task: { "*": "deny", ...Object.fromEntries(names.map((name) => [name, "allow" as const])) } }
}

function ensureSubagentDepth(config: PluginConfigShape): void {
  const depth = config.subagent_depth
  config.subagent_depth = typeof depth === "number" && Number.isFinite(depth) ? Math.max(2, depth) : 2
}

function mergeAgent(existing: Record<string, unknown> | undefined, bundled: Record<string, unknown>, names: string[]): Record<string, unknown> {
  const existingPermission = existing?.permission
  const bundledPermission = bundled.permission as Record<string, unknown> | undefined
  const permission = typeof existingPermission === "string"
    ? { "*": existingPermission, task: taskRules(existingPermission, names), ...bundledPermission }
    : {
        ...(existingPermission as Record<string, unknown> | undefined),
        ...bundledPermission,
      }

  return {
    ...bundled,
    ...existing,
    mode: bundled.mode,
    hidden: bundled.hidden === true,
    permission,
    tools: {
      ...(existing?.tools as Record<string, boolean> | undefined),
      ...(bundled.tools as Record<string, boolean> | undefined),
    },
  }
}

export function createMultireviewPlugin(lifecycle?: ReviewLifecycle): Plugin {
  return async (ctx, pluginOptions) => {
    const options = pluginOptions as MultireviewPluginOptions | undefined
    const modelConfig = loadMultireviewConfig(options ?? {})
    const lifecycleHooks = new ReviewLifecycleHooks(
      lifecycle ?? new PersistentReviewLifecycle(),
      async ({ event, reviewId, sessionID }) => {
        await ctx.client.app.log({
          body: {
            service: "opencode-multireview-plugin",
            level: "warn",
            message: `MMAR review ${reviewId} needs attention after ${event}; completion remains available for session ${sessionID}.`,
            extra: { event, reviewId, sessionID },
          },
          query: { directory: ctx.directory },
        })
      },
    )

    return {
      config: async (cfg: OpenCodeConfig) => {
        const config = cfg as PluginConfigShape
        Object.assign(config, appendBundledSkillPath(config as OpenCodeConfigShape))
        const bundledAgents = buildAgents(modelConfig)
        config.agent = config.agent ?? {}
        for (const [name, bundled] of Object.entries(bundledAgents)) {
          const existing = config.agent[name] as Record<string, unknown> | undefined
          config.agent[name] = mergeAgent(existing, bundled, specialistNames())
        }
        const names = specialistNames()
        restrictTopLevelTask(config, names)
        restrictAgentTaskOverrides(config, names)
        restrictOrchestrator(config, names)
        ensureSubagentDepth(config)
      },
      tool: mmarTools,
      "tool.execute.before": async (input, output) => {
        lifecycleHooks.beforeTool(input, output.args)
      },
      event: async ({ event }) => {
        await lifecycleHooks.event(event)
      },
    }
  }
}

export const MultireviewPlugin: Plugin = createMultireviewPlugin()

export default MultireviewPlugin
export type { MultireviewPluginOptions }
