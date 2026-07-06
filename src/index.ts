import type { Config as OpenCodeConfig, Plugin } from "@opencode-ai/plugin"
import { buildAgents } from "./agents.js"
import { loadMultireviewConfig } from "./config.js"
import type { MultireviewPluginOptions } from "./defaults.js"
import { PLANNOTATOR_PLUGIN_NAME } from "./defaults.js"

function pluginName(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  return undefined
}

function hasPlannotatorPlugin(cfg: OpenCodeConfig): boolean {
  return (cfg.plugin ?? []).some((entry) => pluginName(entry)?.startsWith(PLANNOTATOR_PLUGIN_NAME))
}

function mergeAgent(existing: Record<string, unknown> | undefined, bundled: Record<string, unknown>): Record<string, unknown> {
  return {
    ...bundled,
    ...existing,
    permission: {
      ...(bundled.permission as Record<string, unknown> | undefined),
      ...(existing?.permission as Record<string, unknown> | undefined),
    },
  }
}

export const MultireviewPlugin: Plugin = async (_ctx, options?: MultireviewPluginOptions) => {
  const config = loadMultireviewConfig(options ?? {})

  return {
    config: async (cfg: OpenCodeConfig) => {
      if (config.plannotator.requirePlugin && !hasPlannotatorPlugin(cfg)) {
        throw new Error(
          `opencode-multireview-plugin requires ${PLANNOTATOR_PLUGIN_NAME} to be configured in cfg.plugin. Add ["${PLANNOTATOR_PLUGIN_NAME}@latest", { "workflow": "all-agents" }] before this plugin, or set plannotator.requirePlugin to false for development.`,
        )
      }

      const bundledAgents = buildAgents(config)
      cfg.agent = cfg.agent ?? {}
      for (const [name, bundled] of Object.entries(bundledAgents)) {
        const existing = cfg.agent[name] as Record<string, unknown> | undefined
        cfg.agent[name] = mergeAgent(existing, bundled)
      }
    },
  }
}

export default MultireviewPlugin
export type { MultireviewPluginOptions }
