import type { ModelRef, QuartermasterConfig } from "./config.ts"
import { modelKey, type ModelEligibility } from "./select.ts"
import type { UsageReadResult, UsageSourceID } from "./usage.ts"

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

    const sourceID = usageSources[model.providerID] as UsageSourceID | undefined
    const status = sourceID === undefined
      ? "available"
      : usage?.status === "ok"
        ? usage.snapshot.sources[sourceID].availability
        : "unknown"
    result.set(modelKey(model), { status })
  }

  return result
}
