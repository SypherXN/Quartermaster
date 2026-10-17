import type { ModelRef, QuartermasterConfig } from "./config.ts"
import { modelKey, type ModelEligibility } from "./select.ts"
import type { UsageReadResult, UsageSource, UsageSourceID } from "./usage.ts"

export type ModuleQuota = "unknown" | "available" | "limited"

export function tracksQuota(
  model: Pick<ModelRef, "providerID" | "modelID">,
  usageSources: QuartermasterConfig["usageSources"],
  quotaExemptModels: readonly string[],
): boolean {
  return Object.hasOwn(usageSources, model.providerID) &&
    !quotaExemptModels.includes(`${model.providerID}/${model.modelID}`)
}

export function buildQuotaEligibility(
  registry: readonly ModelRef[],
  usageSources: QuartermasterConfig["usageSources"],
  quotaExemptModels: readonly string[],
  usage: UsageReadResult | undefined,
): ReadonlyMap<string, ModelEligibility> {
  const exemptions = new Set(quotaExemptModels)
  const result = new Map<string, ModelEligibility>()

  for (const model of registry) {
    const qualifiedID = `${model.providerID}/${model.modelID}`
    if (exemptions.has(qualifiedID)) {
      result.set(modelKey(model), { status: "available" })
      continue
    }

    const sourceID = Object.hasOwn(usageSources, model.providerID)
      ? usageSources[model.providerID] as UsageSourceID
      : undefined
    const status = sourceID === undefined
      ? "available"
      : usage?.status === "ok"
        ? usage.snapshot.sources[sourceID].availability
        : "unknown"
    result.set(modelKey(model), { status })
  }

  return result
}

export type ModuleUsageSkip = "limited" | "usage-unavailable"

/** Tracked module quota. Unmapped and exempt models stay unknown. Resets never grant availability. */
export function moduleUsageDecision(
  model: Pick<ModelRef, "providerID" | "modelID">,
  usageSources: QuartermasterConfig["usageSources"],
  quotaExemptModels: readonly string[],
  usage: UsageReadResult | undefined,
): { quota: ModuleQuota; skip?: ModuleUsageSkip } {
  if (!tracksQuota(model, usageSources, quotaExemptModels)) return { quota: "unknown" }
  if (usage?.status !== "ok") return { quota: "unknown", skip: "usage-unavailable" }
  const source = usage.snapshot.sources[usageSources[model.providerID] as UsageSourceID]
  if (!source || source.stale || source.availability === "unknown") return { quota: "unknown", skip: "usage-unavailable" }
  if (source.availability === "limited") return { quota: "limited", skip: "limited" }
  if (source.availability !== "available") return { quota: "unknown", skip: "usage-unavailable" }
  return { quota: "available" }
}
