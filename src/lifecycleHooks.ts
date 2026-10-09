import type { ReviewLifecycle } from "./storage/lifecycle.js"
import { laneForCanonicalSpecialist, type LaneDefinition } from "./lanes.js"

export type ToolBeforeInput = {
  tool: string
  sessionID: string
  callID: string
}

export type Diagnostic = {
  event: "session.error"
  reviewId: string
  sessionID: string
}

type LifecycleEvent = {
  type: string
  data?: unknown
  properties?: { sessionID?: unknown }
}

export type DiagnosticSink = (diagnostic: Diagnostic) => void | Promise<void>

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function specialistType(args: unknown): LaneDefinition | undefined {
  if (!isRecord(args)) return undefined
  // V2's `subagent` tool takes `agent`; V1's `task` tool took `subagent_type`.
  const name = typeof args.agent === "string" ? args.agent : args.subagent_type
  return typeof name === "string" ? laneForCanonicalSpecialist(name) : undefined
}

function sessionIDFromEvent(event: LifecycleEvent): string | undefined {
  if (event.type !== "session.error" && event.type !== "session.execution.failed") return undefined
  const data = event.data && typeof event.data === "object" ? event.data as { sessionID?: unknown } : undefined
  const sessionID = data?.sessionID ?? event.properties?.sessionID
  return typeof sessionID === "string" && sessionID.trim() ? sessionID : undefined
}

export class ReviewLifecycleHooks {
  constructor(
    private readonly lifecycle: ReviewLifecycle,
    private readonly diagnostic: DiagnosticSink,
  ) {}

  beforeTool(input: ToolBeforeInput, args: unknown): void {
    // OpenCode invokes this before-hook with the calling session; throwing here aborts task dispatch.
    if (input.tool !== "subagent" && input.tool !== "task") return
    const specialist = specialistType(args)
    if (!specialist) return
    const activeReview = this.lifecycle.activeReviewForSession(input.sessionID)
    if (!activeReview) {
      throw new Error("MMAR specialist dispatch requires an active review lock owned by this session")
    }
    // laneAware: false is a migration-only compatibility path for locks created before migration 003.
    const laneIsSelected = activeReview.lanes.includes(specialist.name)
    if (activeReview.laneAware && !laneIsSelected) {
      throw new Error("MMAR specialist dispatch is outside the active review lanes")
    }
  }

  async event(event: LifecycleEvent): Promise<void> {
    if (event.type !== "session.error" && event.type !== "session.execution.failed") return
    const sessionID = sessionIDFromEvent(event)
    if (!sessionID) return
    const activeReview = this.lifecycle.activeReviewForSession(sessionID)
    if (!activeReview) return
    // V2 renamed session.error to session.execution.failed; retain the persisted marker for old databases.
    const eventType = "session.error" as const
    const marker = this.lifecycle.recordIncompleteDiagnosticMarker({
      sessionID,
      reviewId: activeReview.reviewId,
      event: eventType,
    })
    if (!marker.deduplicated) {
      try {
        await this.diagnostic({ event: eventType, reviewId: activeReview.reviewId, sessionID })
      } catch (error) {
        try {
          this.lifecycle.releaseIncompleteDiagnosticMarker({
            sessionID,
            reviewId: activeReview.reviewId,
            event: eventType,
          })
        } catch (releaseError) {
          console.warn("Unable to release failed MMAR diagnostic marker", releaseError)
        }
        console.warn("Unable to publish MMAR diagnostic", error)
      }
    }
  }
}
