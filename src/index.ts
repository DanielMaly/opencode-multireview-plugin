import type { Config as OpenCodeConfig, Plugin } from "@opencode-ai/plugin"
import { buildAgents } from "./agents.js"
import { loadMultireviewConfig } from "./config.js"
import type { MultireviewPluginOptions } from "./defaults.js"

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
