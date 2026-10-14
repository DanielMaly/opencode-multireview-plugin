import type { ReviewLifecycle } from "./storage/lifecycle.js"
import { laneForCanonicalSpecialist, type LaneDefinition } from "./lanes.js"

export type ToolBeforeInput = {
  tool: string
  sessionID: string
  callID: string
}

export type Diagnostic = {
  event: "session.execution.failed"
  reviewId: string
  sessionID: string
}

type LifecycleEvent = {
  type: string
  data?: unknown
}

export type DiagnosticSink = (diagnostic: Diagnostic) => void | Promise<void>

type UnknownRecord = Record<string, unknown>

const EDIT_TOOL_NAMES = new Set(["edit", "write", "patch"])

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function specialistType(args: unknown): LaneDefinition | undefined {
  if (!isRecord(args)) return undefined
  return typeof args.agent === "string" ? laneForCanonicalSpecialist(args.agent) : undefined
}

function sessionIDFromEvent(event: LifecycleEvent): string | undefined {
  if (event.type !== "session.execution.failed") return undefined
  const data = event.data && typeof event.data === "object" ? event.data as { sessionID?: unknown } : undefined
  const sessionID = data?.sessionID
  return typeof sessionID === "string" && sessionID.trim() ? sessionID : undefined
}

export class ReviewLifecycleHooks {
  constructor(
    private readonly lifecycle: ReviewLifecycle,
    private readonly diagnostic: DiagnosticSink,
  ) {}

  beforeTool(input: ToolBeforeInput, args: unknown, callerAgent: string): void {
    const isDispatch = input.tool === "subagent"
    const specialist = isDispatch ? specialistType(args) : undefined
    const isOrchestrator = callerAgent === "mmar_orchestrator"
    const isBundledMmarAgent = isOrchestrator || laneForCanonicalSpecialist(callerAgent) !== undefined
    const isEditTool = EDIT_TOOL_NAMES.has(input.tool)
    const dispatchesSpecialist = isDispatch && specialist !== undefined
    const dispatchesNonSpecialist = isDispatch && specialist === undefined
    const unauthorizedSpecialistDispatch = dispatchesSpecialist && !isOrchestrator
    const invalidOrchestratorDispatch = isOrchestrator && dispatchesNonSpecialist
    const bundledEditAttempt = isBundledMmarAgent && isEditTool

    if (unauthorizedSpecialistDispatch) {
      throw new Error("Only mmar_orchestrator may dispatch canonical MMAR specialists")
    }
    if (invalidOrchestratorDispatch) {
      throw new Error("mmar_orchestrator may dispatch only canonical MMAR specialists")
    }
    if (bundledEditAttempt) {
      throw new Error("Bundled MMAR agents may not use edit-class tools")
    }

    if (dispatchesSpecialist) {
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
  }

  async event(event: LifecycleEvent): Promise<void> {
    if (event.type !== "session.execution.failed") return
    const sessionID = sessionIDFromEvent(event)
    if (!sessionID) return
    const activeReview = this.lifecycle.activeReviewForSession(sessionID)
    if (!activeReview) return
    // Persist the legacy marker key while reporting the V2 event type to consumers.
    const markerEvent = "session.error" as const
    const observedEvent = "session.execution.failed" as const
    const marker = this.lifecycle.recordIncompleteDiagnosticMarker({
      sessionID,
      reviewId: activeReview.reviewId,
      event: markerEvent,
    })
    if (!marker.deduplicated) {
      try {
        await this.diagnostic({ event: observedEvent, reviewId: activeReview.reviewId, sessionID })
      } catch (error) {
        try {
          this.lifecycle.releaseIncompleteDiagnosticMarker({
            sessionID,
            reviewId: activeReview.reviewId,
            event: markerEvent,
          })
        } catch (releaseError) {
          console.warn("Unable to release failed MMAR diagnostic marker", releaseError)
        }
        console.warn("Unable to publish MMAR diagnostic", error)
      }
    }
  }
}
