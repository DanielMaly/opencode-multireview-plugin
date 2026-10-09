import { readFileSync } from "node:fs"
import { Plugin } from "@opencode/plugin"
import { buildAgents } from "./agents.js"
import { loadMultireviewConfig } from "./config.js"
import type { MultireviewPluginOptions } from "./defaults.js"
import { ReviewLifecycleHooks } from "./lifecycleHooks.js"
import { skillPath } from "./paths.js"
import { PersistentReviewLifecycle, type ReviewLifecycle } from "./storage/lifecycle.js"
import { mmarTools } from "./tools.js"
import { validateBundledMmarSkill } from "./skillDiscovery.js"
import { laneRegistry } from "./lanes.js"
import { REVIEWER_REGISTRY } from "./defaults.js"

const pluginId = "opencode-multireview-plugin"

function modelReference(model: string, variant?: string): { providerID: string; id: string; variant?: string } {
  const separator = model.indexOf("/")
  const providerID = separator === -1 ? model : model.slice(0, separator)
  const id = separator === -1 ? model : model.slice(separator + 1)
  return variant === undefined ? { providerID, id } : { providerID, id, variant }
}

function permissions(value: unknown): Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> {
  const result: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> = []
  const add = (action: string, resource: string, effect: unknown) => {
    if (effect === "allow" || effect === "deny" || effect === "ask") result.push({ action: action === "task" ? "subagent" : action === "bash" ? "shell" : action, resource, effect })
  }
  if (typeof value === "string") add("*", "*", value)
  else if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [action, setting] of Object.entries(value)) {
      if (typeof setting === "string") add(action, "*", setting)
      else if (setting && typeof setting === "object" && !Array.isArray(setting)) for (const [resource, effect] of Object.entries(setting)) add(action, resource, effect)
    }
  }
  return result
}

function registerAgents(ctx: any, modelConfig: ReturnType<typeof loadMultireviewConfig>): Promise<void> {
  const bundled = buildAgents(modelConfig)
  const orchestrator = REVIEWER_REGISTRY.coordinator.name
  // V1 restricted the orchestrator's task tool to exactly the specialist agents.
  const orchestratorTasks = { "*": "deny", ...Object.fromEntries(laneRegistry.map((lane) => [lane.specialistAgent, "allow"])) }
  return ctx.agent.transform((editor: any) => {
    // V2 update() creates missing agents; config/file agents with the same id are layered on top by the host.
    for (const [id, definition] of Object.entries(bundled)) {
      editor.update(id, (agent: any) => {
        const permission = id === orchestrator ? { ...definition.permission, task: orchestratorTasks } : definition.permission
        Object.assign(agent, {
          id,
          name: id,
          description: definition.description,
          mode: definition.mode,
          hidden: definition.hidden === true,
          model: modelReference(definition.model, definition.variant),
          system: definition.prompt,
          permissions: permissions(permission),
        })
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
            execute: (input: unknown, toolContext: any) => definition.execute(input, {
              ...toolContext,
              directory: ctx.location.directory,
              worktree: ctx.location.project.directory,
            }),
          } as never)
        }
      })
      await registerAgents(ctx, modelConfig)
      validateBundledMmarSkill()
      const skillContent = readFileSync(skillPath, "utf8")
      await ctx.skill.transform((editor) => {
        if (!editor.get("mmar")) {
          editor.add({ id: "mmar" as never, name: "MMAR" as never, description: "Run multi-model adversarial code review", path: skillPath as never, content: skillContent })
        }
      })
      await ctx.tool.hook("execute.before", (event) => {
        lifecycleHooks.beforeTool({ tool: event.tool, sessionID: event.sessionID, callID: event.id }, event.input)
      })

      const controller = new AbortController()
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) await lifecycleHooks.event(event)
      })().catch((error) => {
        if (!controller.signal.aborted) console.warn("Unable to consume MMAR OpenCode events", error)
      })
      return () => controller.abort()
    },
  })
}

export const MultireviewPlugin = createMultireviewPlugin()
export default MultireviewPlugin
export type { MultireviewPluginOptions }
