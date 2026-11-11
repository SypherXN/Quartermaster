import type { ModelRef, QuartermasterConfig } from "./config.ts"
import type { QuotaClock } from "./decision.ts"
import { modelKey, type ModelEligibility } from "./select.ts"
import type { UsageReadResult, UsageSource, UsageSourceID } from "./usage.ts"

export type ModuleQuota = "unknown" | "available" | "limited"

// ponytail: one fixed ceiling for every provider; make it configurable if a
// provider ever needs its own line. At 100 only a filled window blocks, so a
// near-cap window keeps its remaining headroom usable. A provider that reports
// itself limited still blocks at any percentage (see quotaExhausted).
export const QUOTA_BLOCK_PERCENT = 100

/** A fresh source blocks a model when it is already limited or any window is full. */
function quotaExhausted(source: UsageSource | undefined): boolean {
  if (!source || source.stale) return false
  if (source.availability === "limited") return true
  return source.windows.some((window) =>
    window.state === "rate-limited" ||
    (typeof window.usedPercent === "number" && window.usedPercent >= QUOTA_BLOCK_PERCENT))
}

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
    // Quota rule: only FRESH evidence of a limit blocks a model. Absent, stale or
    // otherwise unusable usage must never block -- it reads as available here. Source
    // state stays observable through status/diagnoseSession (src/agent-routing.ts).
    const source = sourceID === undefined || usage?.status !== "ok"
      ? undefined
      : usage.snapshot.sources[sourceID]
    const status = quotaExhausted(source) ? "limited" : "available"
    result.set(modelKey(model), { status })
  }

  return result
}

/**
 * Each model's urgency clock: the provider window that resets first, so the
 * decision plans can spend quota before it expires. Stale evidence and
 * untracked providers report nothing and sort last.
 */
export function quotaClocks(
  usageSources: QuartermasterConfig["usageSources"],
  usage: UsageReadResult | undefined,
): (model: Pick<ModelRef, "providerID" | "modelID">) => QuotaClock | undefined {
  return (model) => {
    if (!Object.hasOwn(usageSources, model.providerID) || usage?.status !== "ok") return undefined
    const source = usage.snapshot.sources[usageSources[model.providerID] as UsageSourceID]
    if (!source || source.stale) return undefined
    let clock: QuotaClock | undefined
    for (const window of source.windows) {
      if (typeof window.resetsAt !== "number") continue
      if (
        clock === undefined ||
        window.resetsAt < (clock.resetsAt as number) ||
        (window.resetsAt === clock.resetsAt && (window.usedPercent ?? -1) > (clock.usedPercent ?? -1))
      ) {
        clock = {
          resetsAt: window.resetsAt,
          ...(typeof window.usedPercent === "number" ? { usedPercent: window.usedPercent } : {}),
        }
      }
    }
    return clock
  }
}

/**
 * How hard each provider can be used right now, in percent of a window per
 * minute: the tightest of its windows, because one request is charged to all of
 * them at once. A rate answers the per-block question too -- how much of the
 * weekly is left for each 5-hour window still to come is the rate times the
 * block's length. Stale evidence, untracked providers and windows with no usable
 * figure report nothing and sort last; a window that has already reset
 * constrains nothing.
 */
export function quotaPaces(
  usageSources: QuartermasterConfig["usageSources"],
  usage: UsageReadResult | undefined,
  now = Date.now(),
): (model: Pick<ModelRef, "providerID" | "modelID">) => number | undefined {
  return (model) => {
    if (!Object.hasOwn(usageSources, model.providerID) || usage?.status !== "ok") return undefined
    const source = usage.snapshot.sources[usageSources[model.providerID] as UsageSourceID]
    if (!source || source.stale) return undefined
    let pace: number | undefined
    for (const window of source.windows) {
      if (typeof window.resetsAt !== "number" || typeof window.usedPercent !== "number") continue
      const minutes = (window.resetsAt - now) / 60_000
      if (minutes <= 0) continue
      const perMinute = (100 - window.usedPercent) / minutes
      if (pace === undefined || perMinute < pace) pace = perMinute
    }
    return pace
  }
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
  if (quotaExhausted(source)) return { quota: "limited", skip: "limited" }
  if (source.availability !== "available") return { quota: "unknown", skip: "usage-unavailable" }
  return { quota: "available" }
}
