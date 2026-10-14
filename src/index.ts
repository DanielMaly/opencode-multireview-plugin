import { readFileSync } from "node:fs"
import { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { Agent } from "@opencode/schema/agent"
import { Skill } from "@opencode/schema/skill"
import { buildAgents } from "./agents.js"
import { loadMultireviewConfig } from "./config.js"
import type { MultireviewPluginOptions } from "./defaults.js"
import { ReviewLifecycleHooks } from "./lifecycleHooks.js"
import { skillPath } from "./paths.js"
import { PersistentReviewLifecycle, type ReviewLifecycle } from "./storage/lifecycle.js"
import { mmarTools } from "./tools.js"
import { validateBundledMmarSkill } from "./skillDiscovery.js"

const pluginId = "opencode-multireview-plugin"

function registerAgents(ctx: Plugin.Context, modelConfig: ReturnType<typeof loadMultireviewConfig>): Promise<void> {
  const bundled = buildAgents(modelConfig)
  return ctx.agent.transform((editor) => {
    // V2 update() creates missing agents; config/file agents with the same id are layered on top by the host.
    for (const [id, definition] of Object.entries(bundled)) {
      editor.update(id, (agent) => {
        agent.id = Agent.ID.make(id)
        agent.name = definition.name
        agent.description = definition.description
        agent.mode = definition.mode
        agent.hidden = definition.hidden
        agent.model = definition.model
        agent.system = definition.system
        agent.permissions = definition.permissions
      })
    }
  }).then(() => undefined)
}

export function createMultireviewPlugin(lifecycle: ReviewLifecycle = new PersistentReviewLifecycle()) {
  return Plugin.define({
    id: pluginId,
    async setup(ctx) {
      const modelConfig = loadMultireviewConfig(ctx.options as MultireviewPluginOptions)
      const lifecycleHooks = new ReviewLifecycleHooks(lifecycle, async ({ event, reviewId, sessionID }) => {
        console.warn(`MMAR review ${reviewId} needs attention after ${event}; completion remains available for session ${sessionID}.`)
      })

      await ctx.tool.transform((editor) => {
        for (const definition of Object.values(mmarTools)) {
          editor.add({
            ...definition,
            execute: (input: unknown, toolContext: ToolContext) => definition.execute(input, {
              ...toolContext,
              directory: ctx.location.directory,
              worktree: ctx.location.project.directory,
            }),
          })
        }
      })
      await registerAgents(ctx, modelConfig)
      validateBundledMmarSkill()
      const skillContent = readFileSync(skillPath, "utf8")
      await ctx.skill.transform((editor) => {
        if (!editor.get("mmar")) {
          editor.add({
            id: Skill.ID.make("mmar"),
            name: Skill.Name.make("MMAR"),
            description: "Run multi-model adversarial code review",
            path: skillPath as Skill.Info["path"],
            content: skillContent,
          })
        }
      })
      await ctx.tool.hook("execute.before", (event) => {
        lifecycleHooks.beforeTool({ tool: event.tool, sessionID: event.sessionID, callID: event.id }, event.input, event.agent)
      })

      const controller = new AbortController()
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            try {
              await lifecycleHooks.event(event)
            } catch (error) {
              console.warn("Unable to process MMAR OpenCode event", error)
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) console.warn("Unable to consume MMAR OpenCode events", error)
        }
      })().catch((error) => {
        if (!controller.signal.aborted) console.warn("Unexpected MMAR event consumer failure", error)
      })
      return () => controller.abort()
    },
  })
}

export const MultireviewPlugin = createMultireviewPlugin()
export default MultireviewPlugin
export type { MultireviewPluginOptions }
