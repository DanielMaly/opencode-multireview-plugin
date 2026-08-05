import type { Config as OpenCodeConfig, Plugin } from "@opencode-ai/plugin"
import { buildAgents } from "./agents.js"
import { loadMultireviewConfig } from "./config.js"
import type { MultireviewPluginOptions } from "./defaults.js"
import { ReviewLifecycleHooks } from "./lifecycleHooks.js"
import { appendBundledSkillPath, type OpenCodeConfigShape } from "./skillDiscovery.js"
import { PersistentReviewLifecycle, type ReviewLifecycle } from "./storage/lifecycle.js"
import { mmarTools } from "./tools.js"

function mergeAgent(existing: Record<string, unknown> | undefined, bundled: Record<string, unknown>): Record<string, unknown> {
  return {
    ...bundled,
    ...existing,
    permission: {
      ...(existing?.permission as Record<string, unknown> | undefined),
      ...(bundled.permission as Record<string, unknown> | undefined),
    },
    tools: {
      ...(existing?.tools as Record<string, boolean> | undefined),
      ...(bundled.tools as Record<string, boolean> | undefined),
    },
  }
}

export function createMultireviewPlugin(lifecycle?: ReviewLifecycle): Plugin {
  return async (ctx, pluginOptions) => {
    const options = pluginOptions as MultireviewPluginOptions | undefined
    const config = loadMultireviewConfig(options ?? {})
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
        Object.assign(cfg, appendBundledSkillPath(cfg as OpenCodeConfigShape))
        const bundledAgents = buildAgents(config)
        cfg.agent = cfg.agent ?? {}
        for (const [name, bundled] of Object.entries(bundledAgents)) {
          const existing = cfg.agent[name] as Record<string, unknown> | undefined
          cfg.agent[name] = mergeAgent(existing, bundled)
        }
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
