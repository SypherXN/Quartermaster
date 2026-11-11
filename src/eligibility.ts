import type { ModelRef, QuartermasterConfig } from "./config.ts"
import type { QuotaClock } from "./decision.ts"
import { QUOTA_BLOCK_PERCENT, freshObservationAt, type QuotaEstimates } from "./quota-estimates.ts"
import { modelKey, type ModelEligibility } from "./select.ts"
import type { UsageReadResult, UsageSource, UsageSourceID } from "./usage.ts"

export { QUOTA_BLOCK_PERCENT }

export type ModuleQuota = "unknown" | "available" | "limited"

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

/** The tightest sustainable pace among a source's future windows, if any. */
function sourcePace(source: UsageSource, now: number): number | undefined {
  let pace: number | undefined
  for (const window of source.windows) {
    if (typeof window.resetsAt !== "number" || typeof window.usedPercent !== "number") continue
    const minutes = (window.resetsAt - now) / 60_000
    if (minutes <= 0) continue
    const perMinute = (QUOTA_BLOCK_PERCENT - window.usedPercent) / minutes
    if (pace === undefined || perMinute < pace) pace = perMinute
  }
  return pace
}

/**
 * The same figure for the two evidence strategies, with malformed windows
 * dropped instead of propagating NaN, Infinity or an out-of-range percentage.
 * `quotaPaces` keeps its previous permissive read so old strategies do not move.
 */
function strictPace(source: UsageSource, now: number): number | undefined {
  let pace: number | undefined
  for (const window of source.windows) {
    const percent = window.usedPercent
    const resetsAt = window.resetsAt
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue
    if (percent < 0 || percent > QUOTA_BLOCK_PERCENT) continue
    if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) continue
    const minutes = (resetsAt - now) / 60_000
    if (!(minutes > 0) || !Number.isFinite(minutes)) continue
    const perMinute = (QUOTA_BLOCK_PERCENT - percent) / minutes
    if (!Number.isFinite(perMinute) || perMinute < 0) continue
    if (pace === undefined || perMinute < pace) pace = perMinute
  }
  return pace
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
    return sourcePace(source, now)
  }
}

/**
 * Pace with the evidence rules the two new strategies share: the source must be
 * authenticated, error-free and observed within the last five minutes. Older
 * snapshots report nothing, exactly like an untracked provider.
 */
export function quotaFreshPaces(
  usageSources: QuartermasterConfig["usageSources"],
  usage: UsageReadResult | undefined,
  now = Date.now(),
): (model: Pick<ModelRef, "providerID" | "modelID">) => number | undefined {
  return (model) => {
    if (!Object.hasOwn(usageSources, model.providerID) || usage?.status !== "ok") return undefined
    const source = usage.snapshot.sources[usageSources[model.providerID] as UsageSourceID]
    if (!source || freshObservationAt(source, now) === undefined) return undefined
    return strictPace(source, now)
  }
}

/**
 * The protection factor for one window: how much of its sustainable pace is
 * actually usable before the forecast cutoff. `undefined` means the window
 * cannot contribute evidence (no history, flat/no trend, stale data, a guessed
 * or past reset, malformed figures), which leaves the factor neutral at 1.
 */
function windowProtection(
  sourceID: UsageSourceID,
  window: UsageSource["windows"][number],
  estimates: QuotaEstimates,
  now: number,
): number | undefined {
  // A reset the source guessed cannot bound a ratio; leave ordinary pace alone.
  if (window.resetEstimated === true) return undefined
  const percent = window.usedPercent
  const resetsAt = window.resetsAt
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined
  if (percent < 0 || percent > QUOTA_BLOCK_PERCENT) return undefined
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= now) return undefined
  const estimate = estimates.estimate(sourceID, window, now)
  if (!estimate || estimate.status !== "estimated") return undefined
  // QuotaEstimates normally enforces these, but a protection factor must not
  // depend on that: a two-point, 15-minute trend is the floor for evidence.
  if (estimate.sampleCount < 2 || estimate.spanMs < 900_000) return undefined
  const rate = estimate.ratePerMinute
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return undefined
  const minutesToReset = (resetsAt - now) / 60_000
  if (!Number.isFinite(minutesToReset) || minutesToReset <= 0) return undefined
  // Derive the cutoff from the current percentage, not a cached cutoffAt, so a
  // percentage that moved since the forecast cannot skew the ratio.
  const minutesToCutoff = (QUOTA_BLOCK_PERCENT - percent) / rate
  const ratio = minutesToCutoff / minutesToReset
  return Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : undefined
}

/**
 * Pace scaled by window protection: each provider's tightest sustainable rate
 * times the smallest ratio across its usable forecasts (exhaustion before reset
 * holds it back; exhaustion after reset never does). Evidence is per provider,
 * so every model on that provider shares it.
 */
export function quotaProtectedPaces(
  usageSources: QuartermasterConfig["usageSources"],
  usage: UsageReadResult | undefined,
  estimates: QuotaEstimates,
  now = Date.now(),
): (model: Pick<ModelRef, "providerID" | "modelID">) => number | undefined {
  return (model) => {
    if (!Object.hasOwn(usageSources, model.providerID) || usage?.status !== "ok") return undefined
    const sourceID = usageSources[model.providerID] as UsageSourceID
    const source = usage.snapshot.sources[sourceID]
    if (!source || freshObservationAt(source, now) === undefined) return undefined
    const pace = strictPace(source, now)
    if (pace === undefined) return undefined
    let factor = 1
    for (const window of source.windows) {
      const protection = windowProtection(sourceID, window, estimates, now)
      if (protection !== undefined && protection < factor) factor = protection
    }
    const protectedPace = pace * factor
    return Number.isFinite(protectedPace) && protectedPace >= 0 ? protectedPace : undefined
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
