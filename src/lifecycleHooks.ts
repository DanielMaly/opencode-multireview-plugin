import type { Event } from "@opencode-ai/sdk"
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

export type DiagnosticSink = (diagnostic: Diagnostic) => void | Promise<void>

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function specialistType(args: unknown): LaneDefinition | undefined {
  if (!isRecord(args) || typeof args.subagent_type !== "string") return undefined
  return laneForCanonicalSpecialist(args.subagent_type)
}

function sessionIDFromEvent(event: Event): string | undefined {
  if (event.type !== "session.error") return undefined
  const sessionID = event.properties.sessionID
  return typeof sessionID === "string" && sessionID.trim() ? sessionID : undefined
}

export class ReviewLifecycleHooks {
  constructor(
    private readonly lifecycle: ReviewLifecycle,
    private readonly diagnostic: DiagnosticSink,
  ) {}

  beforeTool(input: ToolBeforeInput, args: unknown): void {
    // OpenCode invokes this before-hook with the calling session; throwing here aborts task dispatch.
    if (input.tool !== "task") return
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

  async event(event: Event): Promise<void> {
    if (event.type !== "session.error") return
    const sessionID = sessionIDFromEvent(event)
    if (!sessionID) return
    const activeReview = this.lifecycle.activeReviewForSession(sessionID)
    if (!activeReview) return
    const eventType = event.type
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
