import type { ModelRef, QuartermasterConfig } from "./config.ts"
import type { QuotaClock } from "./decision.ts"
import { QUOTA_BLOCK_PERCENT, freshObservationAt, type QuotaEstimates } from "./quota-estimates.ts"
import { modelKey, type ModelEligibility } from "./select.ts"
import type { UsageReadResult, UsageSource, UsageSourceID } from "./usage.ts"

export { QUOTA_BLOCK_PERCENT }

/**
 * No window is scored over a horizon longer than this. A percentage is only
 * comparable within one window, so an uncapped monthly window divides a small
 * remainder by a month and reports a rate no weekly or 5-hour window can match
 * downwards, which pins every race against that provider. Beyond a week the
 * difference no longer changes what a router should do, so the urgency saturates.
 */
const PACE_HORIZON_MINUTES = 7 * 24 * 60

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
    const minutes = Math.min((window.resetsAt - now) / 60_000, PACE_HORIZON_MINUTES)
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
    const minutes = Math.min((resetsAt - now) / 60_000, PACE_HORIZON_MINUTES)
    if (!(minutes > 0) || !Number.isFinite(minutes)) continue
    const perMinute = (QUOTA_BLOCK_PERCENT - percent) / minutes
    if (!Number.isFinite(perMinute) || perMinute < 0) continue
    if (pace === undefined || perMinute < pace) pace = perMinute
  }
  return pace
}

/**
 * The remaining headroom of a provider's tightest window, in percentage points.
 * Window length is deliberately excluded: a per-minute rate lets a freshly reset
 * 5-hour block outbid a monthly allowance by roughly a hundredfold. Malformed
 * windows are dropped instead of propagating NaN or an out-of-range percentage.
 */
function strictHeadroom(source: UsageSource, now: number): number | undefined {
  let headroom: number | undefined
  for (const window of source.windows) {
    const percent = window.usedPercent
    const resetsAt = window.resetsAt
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue
    if (percent < 0 || percent > QUOTA_BLOCK_PERCENT) continue
    if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) continue
    // A reset in the past means the percentage is stale and constrains nothing.
    if (!(resetsAt > now)) continue
    const remaining = QUOTA_BLOCK_PERCENT - percent
    if (!Number.isFinite(remaining) || remaining < 0) continue
    if (headroom === undefined || remaining < headroom) headroom = remaining
  }
  return headroom
}

/**
 * A monthly allowance is about twice a weekly one, so the last week can only
 * consume half of it: the monthly must already be at 50% when a week remains,
 * then ramp to 100% as its reset approaches, or the remainder is wasted.
 */
const MONTHLY_RESERVE_HOURS = 168
const MONTHLY_RESERVE_PERCENT = 50
const MONTHLY_WINDOW_NAME = /^monthly$/i

/** Monthly percentage that should already be spent at this many hours to reset. */
function requiredMonthlyPercent(remainingHours: number): number {
  const ramp = Math.max(0, MONTHLY_RESERVE_HOURS - remainingHours) *
    (MONTHLY_RESERVE_PERCENT / MONTHLY_RESERVE_HOURS)
  return Math.min(QUOTA_BLOCK_PERCENT, Math.max(0, MONTHLY_RESERVE_PERCENT + ramp))
}

/**
 * How many percentage points a provider's monthly window is behind the reserve
 * line, 0 when it is on schedule, `undefined` when it has no usable monthly
 * window. Malformed and already-reset windows are skipped like `strictHeadroom`.
 */
function strictMonthlyDeficit(source: UsageSource, now: number): number | undefined {
  let seen = false
  let deficit = 0
  for (const window of source.windows) {
    if (typeof window.name !== "string" || !MONTHLY_WINDOW_NAME.test(window.name)) continue
    const percent = window.usedPercent
    const resetsAt = window.resetsAt
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue
    if (percent < 0 || percent > QUOTA_BLOCK_PERCENT) continue
    if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) continue
    // A reset in the past means the percentage is stale and constrains nothing.
    if (!(resetsAt > now)) continue
    const required = requiredMonthlyPercent((resetsAt - now) / 3_600_000)
    const behind = Math.max(0, required - percent)
    if (!Number.isFinite(behind)) continue
    seen = true
    if (behind > deficit) deficit = behind
  }
  return seen ? deficit : undefined
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
 * Headroom with the evidence rules the two weighted strategies share: the source
 * must be authenticated, error-free and observed within the last five minutes.
 * Older snapshots report nothing, exactly like an untracked provider.
 */
export function quotaFreshHeadroom(
  usageSources: QuartermasterConfig["usageSources"],
  usage: UsageReadResult | undefined,
  now = Date.now(),
): (model: Pick<ModelRef, "providerID" | "modelID">) => number | undefined {
  return (model) => {
    if (!Object.hasOwn(usageSources, model.providerID) || usage?.status !== "ok") return undefined
    const source = usage.snapshot.sources[usageSources[model.providerID] as UsageSourceID]
    if (!source || freshObservationAt(source, now) === undefined) return undefined
    return strictHeadroom(source, now)
  }
}

/**
 * The monthly reserve deficit with the same evidence rules as
 * `quotaFreshHeadroom`: authenticated, error-free and observed within five
 * minutes. `0` means the provider is on schedule or has no usable monthly
 * window, so it gets no boost; `undefined` means there is no usable evidence at
 * all.
 */
export function quotaMonthlyDeficit(
  usageSources: QuartermasterConfig["usageSources"],
  usage: UsageReadResult | undefined,
  now = Date.now(),
): (model: Pick<ModelRef, "providerID" | "modelID">) => number | undefined {
  return (model) => {
    if (!Object.hasOwn(usageSources, model.providerID) || usage?.status !== "ok") return undefined
    const source = usage.snapshot.sources[usageSources[model.providerID] as UsageSourceID]
    if (!source || freshObservationAt(source, now) === undefined) return undefined
    return strictMonthlyDeficit(source, now) ?? 0
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
