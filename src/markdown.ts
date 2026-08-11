import type { ReviewRound, ReviewSummary } from "./review.js"

export interface ReviewMarkdownMetadata {
  reviewId: string
  targetKind: string
  targetLabel: string
  baseRef: string
  baseCommit: string
}

function text(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim()
}

function findingHeading(finding: { severity: string; category: string; title: string }): string {
  return `**[${finding.severity}] [${finding.category}] ${text(finding.title)}**`
}

function findingBlock(finding: { severity: string; category: string; title: string; bodyMarkdown: string; blockedByUncertaintyIds: string[]; wontfix?: string }, ignored: boolean): string {
  const lines = [findingHeading(finding), "", text(finding.bodyMarkdown)]
  if (finding.blockedByUncertaintyIds.length > 0) {
    const ids = finding.blockedByUncertaintyIds.map((id) => `MULTIREVIEW-UNCERTAINTY-${id}`).join(", ")
    lines.push("", `**Blocked by intent:** ${ids}`)
  }
  if (ignored && finding.wontfix) lines.push("", `**Wontfix: ${text(finding.wontfix)}**`)
  return lines.join("\n")
}

function uncertaintyBlock(uncertainty: ReviewRound["uncertainties"][number], ordinal: number): string {
  return [
    `**[UNCERTAINTY] MULTIREVIEW-UNCERTAINTY-${ordinal}: ${text(uncertainty.title)}**`,
    "",
    "**Observed evidence:**",
    text(uncertainty.observedEvidence),
    "",
    "**Missing or conflicting context:**",
    text(uncertainty.missingContext),
    "",
    "**Clarification question:**",
    text(uncertainty.clarificationQuestion),
  ].join("\n")
}

function section(title: string, entries: string[], empty: string): string {
  return [`## ${title}`, "", entries.length > 0 ? entries.join("\n\n") : empty].join("\n")
}

export function serializeReviewMarkdown(metadata: ReviewMarkdownMetadata, summary: ReviewSummary, round: ReviewRound): string {
  const header = [
    "# MMAR Review",
    "",
    `- Review ID: ${metadata.reviewId}`,
    `- Round ID: ${round.id}`,
    `- Target kind: ${metadata.targetKind}`,
    `- Target label: ${text(metadata.targetLabel)}`,
    `- Base ref: ${text(metadata.baseRef)}`,
    `- Base commit: ${text(metadata.baseCommit)}`,
    `- Completed at: ${round.completedAt}`,
    ...(round.intent ? [`- Intent reference: ${round.intent.type}:${text(round.intent.ref)}`] : []),
  ].join("\n")

  const valid = round.validFindings.map((finding) => findingBlock(finding, false))
  const uncertainties = round.uncertainties.map((uncertainty, index) => uncertaintyBlock(uncertainty, index + 1))
  const ignored = round.ignoredFindings.map((finding) => findingBlock(finding, true))

  return [
    header,
    "",
    section("Valid Findings", valid, "_No valid findings._"),
    "",
    section("Intent Uncertainties", uncertainties, "_No intent uncertainties._"),
    "",
    section("Ignored Findings", ignored, "_No ignored findings._"),
    "",
  ].join("\n")
}
