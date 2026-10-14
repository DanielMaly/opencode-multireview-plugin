import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { AbsolutePath, Skill } from "@opencode/schema"
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
type OpenCodeToolContext = Parameters<Awaited<ReturnType<Plugin.Context["tool"]["list"]>>[number]["execute"]>[1]

function modelReference(model: string, variant?: string): { providerID: string; id: string; variant?: string } {
  const separator = model.indexOf("/")
  if (separator === -1) throw new Error(`Invalid model reference "${model}"; expected "provider/model"`)
  const providerID = model.slice(0, separator)
  const id = model.slice(separator + 1)
  return variant === undefined ? { providerID, id } : { providerID, id, variant }
}

// V2 renamed these V1 permission keys; agent frontmatter still uses the V1 names.
const v2ActionNames: Record<string, string> = { task: "subagent", bash: "shell" }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

function permissions(value: unknown): Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> {
  const result: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> = []
  const add = (action: string, resource: string, effect: unknown) => {
    if (effect === "allow" || effect === "deny" || effect === "ask") result.push({ action: v2ActionNames[action] ?? action, resource, effect })
  }
  if (typeof value === "string") add("*", "*", value)
  if (!isRecord(value)) return result
  for (const [action, setting] of Object.entries(value)) {
    if (typeof setting === "string") add(action, "*", setting)
    else if (isRecord(setting)) for (const [resource, effect] of Object.entries(setting)) add(action, resource, effect)
  }
  return result
}

function toolPermissions(value: Record<string, boolean>): Array<{ action: string; resource: string; effect: "allow" | "deny" }> {
  return Object.entries(value).map(([action, enabled]) => ({ action, resource: "*", effect: enabled ? "allow" : "deny" }))
}

function registerAgents(ctx: Plugin.Context, modelConfig: ReturnType<typeof loadMultireviewConfig>): Promise<void> {
  const bundled = buildAgents(modelConfig)
  const orchestrator = REVIEWER_REGISTRY.coordinator.name
  // V1 restricted the orchestrator's task tool to exactly the specialist agents.
  const orchestratorTasks = { "*": "deny", ...Object.fromEntries(laneRegistry.map((lane) => [lane.specialistAgent, "allow"])) }
  return ctx.agent.transform((editor) => {
    // The installer creates the agent files; V2 update() fills those discovered agents with plugin definitions.
    for (const [id, definition] of Object.entries(bundled)) {
      editor.update(id, (agent) => {
        const permission = id === orchestrator ? { ...definition.permission, task: orchestratorTasks } : definition.permission
        Object.assign(agent, {
          id,
          name: id,
          description: definition.description,
          mode: definition.mode,
          hidden: definition.hidden === true,
          model: modelReference(definition.model, definition.variant),
          system: definition.prompt,
          permissions: [...permissions(permission), ...toolPermissions(definition.tools)],
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
            execute: (input: unknown, toolContext: OpenCodeToolContext) => definition.execute(input, {
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
          editor.add({ id: Schema.decodeSync(Skill.ID)("mmar"), name: Schema.decodeSync(Skill.Name)("MMAR"), description: "Run multi-model adversarial code review", path: Schema.decodeSync(AbsolutePath)(skillPath), content: skillContent })
        }
      })
      await ctx.tool.hook("execute.before", (event) => {
        lifecycleHooks.beforeTool({ tool: event.tool, sessionID: event.sessionID, callID: event.id }, event.input)
      })

      const controller = new AbortController()
      let agentsRefreshed = false
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "agent.updated" && !agentsRefreshed) {
            agentsRefreshed = true
            await registerAgents(ctx, modelConfig)
          }
          await lifecycleHooks.event(event)
        }
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
