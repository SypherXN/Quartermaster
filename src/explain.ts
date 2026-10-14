import type { ModelRef } from "./config.ts"
import { lastLoopbackDetail } from "./local-health.ts"
import type { SelectionResult, SkipReason } from "./select.ts"

const skipMessages: Record<SkipReason, string> = {
  "not-in-registry": "model is not enabled in the OpenCode registry",
  "status-missing": "availability status is missing",
  "local-offline": "configured local endpoint is offline",
  unknown: "provider availability is unknown",
  stale: "provider availability is stale",
  limited: "provider quota is confirmed limited",
  cooldown: "provider or model is in a temporary cooldown",
  "exclusive-busy": "another session is using this exclusive model",
}

function modelName(model: ModelRef): string {
  return `${model.providerID}/${model.modelID}${model.variant ? ` (${model.variant})` : ""}`
}

export interface SelectionExplanation {
  status: SelectionResult["status"]
  selected?: ModelRef
  reasonCode: string
  reason: string
  skipped: Array<{ model: ModelRef; code: SkipReason; reason: string }>
}

export function explainSelection(selection: SelectionResult): SelectionExplanation {
  return {
    status: selection.status,
    ...(selection.status === "selected" ? { selected: selection.model } : {}),
    reasonCode: selection.reason.code,
    reason: selection.status === "selected"
      ? selection.reason.code === "manual-pin"
        ? "Selected because this model is pinned for the agent."
        : "Selected as the highest-priority eligible candidate."
      : selection.status === "no-plan"
        ? "No model plan is configured for this agent."
        : "No candidate in the configured plan is eligible.",
    skipped: selection.skipped.map(({ model, reason }) => ({
      model,
      code: reason.code,
      reason: `${modelName(model)} skipped: ${skipMessages[reason.code]}${reason.code === "local-offline" && lastLoopbackDetail ? ` (${lastLoopbackDetail})` : ""}.`,
    })),
  }
}
