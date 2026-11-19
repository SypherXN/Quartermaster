import type { QuartermasterConfig, TokenRateConfig } from "./config.ts"
import { freshObservationAt } from "./quota-estimates.ts"
import { selectPrice, type PriceTable } from "./telemetry/prices.ts"
import type { TokenTelemetryRecord } from "./telemetry/types.ts"
import type { UsageReadResult, UsageSourceID, UsageWindow } from "./usage.ts"

/**
 * API-equivalent quota valuation. A tiny in-memory buffer of persisted token
 * records lets each fresh quota observation price the work seen since the
 * window's tracking anchor. Nothing here writes storage, scans the ledger, or
 * backfills history; restart simply anchors on the first fresh quota read.
 */
export const QUOTA_VALUE_BUFFER_LIMIT = 10_000
export const MIN_VALUE_SPAN_MS = 15 * 60_000
export const MIN_VALUE_DELTA_PERCENT = 1
export const MAX_VALUE_OBSERVATION_GAP_MS = 15 * 60_000

export const VALUE_REASON_NEED_SPAN = "Need 15 minutes of fresh observations"
export const VALUE_REASON_NEED_DELTA = "Not enough quota change to project"
export const VALUE_REASON_NO_PRICES = "API prices unavailable"
export const VALUE_REASON_NO_WORK = "No observed API-equivalent work"
export const VALUE_REASON_CACHE = "Cache pricing incomplete"
export const VALUE_REASON_TOKENS = "Token counts incomplete"
export const VALUE_REASON_NON_USD = "Non-USD pricing unsupported"
export const VALUE_REASON_RESTARTED = "Tracking restarted"
export const VALUE_REASON_LIMIT = "Tracking record limit reached"
export const VALUE_REASON_STALE = "Quota observation stale"
export const VALUE_REASON_GAP = "Quota observations had a gap"
export const VALUE_REASON_BASIS = "Quota tracking basis changed"

export type QuotaProjectionStatus = "estimated" | "unavailable"

// Frozen UI shape. Every field is present except the two amounts, which are null
// when there is nothing priceable or nothing projectable.
export interface QuotaApiValue {
  currency: "USD"
  basis: "api-equivalent-not-billed"
  observedUSD: number | null
  projectedFullUSD: number | null
  projectionStatus: QuotaProjectionStatus
  reason: string | null
  trackingSince: number | null
  observedAt: number
  spanMs: number
  quotaDeltaPercent: number | null
  records: number
  pricedRecords: number
  unpricedRecords: number
  partialRecords: number
  complete: false
}

export interface QuotaApiValueSnapshot {
  event: "reset" | "maxed"
  segmentID: string
  capturedAt: number
  value: QuotaApiValue
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0
const whole = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown, max = 128): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value

export function asQuotaApiValue(value: unknown): QuotaApiValue | undefined {
  if (!isRecord(value)) return undefined
  if (value.currency !== "USD" || value.basis !== "api-equivalent-not-billed") return undefined
  if (value.complete !== false) return undefined
  if (value.projectionStatus !== "estimated" && value.projectionStatus !== "unavailable") return undefined
  const projectionStatus = value.projectionStatus
  const reason = value.reason
  if (!(reason === null || (text(reason, 160) && !/[\u0000-\u001f\u007f]/.test(reason)))) return undefined
  const trackingSince = value.trackingSince
  const observedAt = value.observedAt
  const spanMs = value.spanMs
  const delta = value.quotaDeltaPercent
  const records = value.records
  const pricedRecords = value.pricedRecords
  const unpricedRecords = value.unpricedRecords
  const partialRecords = value.partialRecords
  const observedUSD = value.observedUSD
  const projectedFullUSD = value.projectedFullUSD
  if (!(trackingSince === null || whole(trackingSince))) return undefined
  if (!whole(observedAt) || !whole(spanMs)) return undefined
  if (!(delta === null || nonnegative(delta))) return undefined
  if (!whole(records) || !whole(pricedRecords) || !whole(unpricedRecords) || !whole(partialRecords)) return undefined
  if (pricedRecords + unpricedRecords !== records) return undefined
  if (partialRecords > records) return undefined
  // Pricedness is consistent: no priced work means no known dollars, and known
  // dollars require at least one priced record. Explicit zero rates are real.
  if ((observedUSD === null) !== (pricedRecords === 0)) return undefined
  if (!(observedUSD === null || nonnegative(observedUSD))) return undefined
  if (!(projectedFullUSD === null || nonnegative(projectedFullUSD))) return undefined
  if (trackingSince !== null && (trackingSince > observedAt || observedAt - trackingSince !== spanMs)) return undefined
  if (trackingSince === null && spanMs !== 0) return undefined
  if (delta !== null && delta > 100) return undefined
  if (projectionStatus === "estimated") {
    if (projectedFullUSD === null || reason !== null) return undefined
    if (observedUSD === null || pricedRecords < 1) return undefined
    if (unpricedRecords !== 0 || partialRecords !== 0) return undefined
    if (spanMs < MIN_VALUE_SPAN_MS) return undefined
    if (delta === null || delta < MIN_VALUE_DELTA_PERCENT) return undefined
  } else if (projectedFullUSD !== null || reason === null) return undefined
  return {
    currency: "USD",
    basis: "api-equivalent-not-billed",
    observedUSD,
    projectedFullUSD,
    projectionStatus,
    reason,
    trackingSince,
    observedAt,
    spanMs,
    quotaDeltaPercent: delta,
    records,
    pricedRecords,
    unpricedRecords,
    partialRecords,
    complete: false,
  }
}

export function asQuotaApiValueSnapshot(value: unknown): QuotaApiValueSnapshot | undefined {
  if (!isRecord(value)) return undefined
  if (value.event !== "reset" && value.event !== "maxed") return undefined
  const event = value.event
  const segmentID = value.segmentID
  const capturedAt = value.capturedAt
  if (!text(segmentID) || !whole(capturedAt)) return undefined
  const apiValue = asQuotaApiValue(value.value)
  if (!apiValue || apiValue.observedAt > capturedAt) return undefined
  return { event, segmentID, capturedAt, value: apiValue }
}

/** A bounded map of persisted token records. Overflow is explicit, never silent. */
export class QuotaValueBuffer {
  private records = new Map<string, TokenTelemetryRecord>()
  private dropped = false

  add(record: TokenTelemetryRecord): void {
    if (this.records.has(record.hostEventID)) {
      this.records.set(record.hostEventID, record)
      return
    }
    if (this.records.size >= QUOTA_VALUE_BUFFER_LIMIT) {
      this.dropped = true
      return
    }
    this.records.set(record.hostEventID, record)
  }

  remove(hostEventIDs: readonly string[]): void {
    for (const id of hostEventIDs) this.records.delete(id)
  }

  /** Drop only records that can no longer fall inside any active span. */
  pruneBefore(at: number): void {
    for (const [id, record] of this.records) {
      if (record.completedAt <= at) this.records.delete(id)
    }
  }

  get overflowed(): boolean {
    return this.dropped
  }

  clearOverflow(): void {
    this.dropped = false
  }

  get size(): number {
    return this.records.size
  }

  between(after: number, through: number): TokenTelemetryRecord[] {
    const found: TokenTelemetryRecord[] = []
    for (const record of this.records.values()) {
      if (record.completedAt > after && record.completedAt <= through) found.push(record)
    }
    return found.sort((left, right) => left.completedAt - right.completedAt || left.hostEventID.localeCompare(right.hostEventID))
  }
}

export interface QuotaValueRecovery {
  percent: number
  observedAt: number
  resetsAt: number | null
  state: UsageWindow["state"]
  apiValue: QuotaApiValue
}

export interface PreparedQuotaValue {
  apiValue: QuotaApiValue
  apiValueSnapshots: QuotaApiValueSnapshot[]
  commit(): void
}

export interface QuotaValueOptions {
  /**
   * The observation is already archived and is only now being seen by this
   * process (same clock after a restart, or a reused point). The token buffer is
   * fed live only, so work completed between that clock and process start is
   * absent; a seed with no prior state is committed but never anchors a span.
   */
  seed?: boolean
  /**
   * The caller has durably recorded that the previous window closed before this
   * observation (the archive cannot always see it in the percentage alone, for
   * example a failed boundary write followed by a rebound). It closes the previous
   * frozen segment and reanchors exactly like an observed reset, but only for a
   * series that already has state: with no state there is nothing to close.
   */
  boundary?: boolean
}

export interface QuotaValuePlan {
  valueFor(sourceID: string, windowName: string, at: number, options?: QuotaValueOptions): PreparedQuotaValue | undefined
  recover(sourceID: string, windowName: string, point: QuotaValueRecovery): void
}

interface SeriesState {
  anchorPercent: number
  anchorAt: number
  segmentID: string
  lastPercent: number
  lastObservedAt: number
  lastResetsAt: number | null
  lastValue: QuotaApiValue
  maxed: boolean
  mapping: string
  pricing: string
}

interface RecordSummary {
  records: number
  pricedRecords: number
  unpricedRecords: number
  partialRecords: number
  usd: number
  hasPriced: boolean
  cacheIncomplete: boolean
  countsIncomplete: boolean
  nonUsd: boolean
  correlationIncomplete: boolean
}

function emptySummary(): RecordSummary {
  return {
    records: 0, pricedRecords: 0, unpricedRecords: 0, partialRecords: 0, usd: 0,
    hasPriced: false, cacheIncomplete: false, countsIncomplete: false, nonUsd: false, correlationIncomplete: false,
  }
}

interface PricedRecord {
  usd: number
  cacheIncomplete: boolean
  nonUsd: boolean
}

// Exact config rates first, then a catalog row that actually prices tokens.
// An all-zero row is a subscription marker, not a price; hostCostUSD is never
// substituted and no underlying-model alias is guessed.
function priceRecord(
  record: TokenTelemetryRecord,
  rates: ReadonlyMap<string, TokenRateConfig>,
  prices: PriceTable | undefined,
): PricedRecord | undefined {
  const counts = record.counts
  if (!counts || !whole(counts.input) || !whole(counts.output) || !whole(counts.cacheRead) || !whole(counts.cacheWrite)) {
    return undefined
  }
  const identity = record.providerID && record.modelID
    ? JSON.stringify([record.providerID, record.modelID, record.variant ?? null])
    : undefined
  const rate = identity === undefined ? undefined : rates.get(identity)
  if (rate) {
    if (rate.currency !== "USD") return { usd: 0, cacheIncomplete: false, nonUsd: true }
    const usd = (counts.input * rate.inputPerMillion + counts.output * rate.outputPerMillion) / 1_000_000
    if (!Number.isFinite(usd) || usd < 0) return undefined
    return { usd, cacheIncomplete: counts.cacheRead + counts.cacheWrite > 0, nonUsd: false }
  }
  if (!record.providerID || !record.modelID) return undefined
  const row = selectPrice(prices?.get(`${record.providerID}/${record.modelID}`), counts.input + counts.cacheRead)
  if (!row) return undefined
  if (row.input === 0 && row.output === 0 && row.cacheRead === 0 && row.cacheWrite === 0) return undefined
  const usd = (counts.input * row.input + counts.output * row.output +
    counts.cacheRead * row.cacheRead + counts.cacheWrite * row.cacheWrite) / 1_000_000
  if (!Number.isFinite(usd) || usd < 0) return undefined
  return {
    usd,
    cacheIncomplete: (counts.cacheRead > 0 && row.cacheReadKnown === false) ||
      (counts.cacheWrite > 0 && row.cacheWriteKnown === false),
    nonUsd: false,
  }
}

function mappingSignature(config: QuartermasterConfig): string {
  return JSON.stringify([
    Object.entries(config.usageSources).sort(([a], [b]) => a.localeCompare(b)),
    [...config.quotaExemptModels].sort(),
  ])
}

// Per source: only the providers mapped to this source can price its records, so
// a price change for one source's models must not reanchor every other source.
function pricingSignature(config: QuartermasterConfig, prices: PriceTable, sourceID: string): string {
  const providers = new Set<string>()
  for (const [providerID, mapped] of Object.entries(config.usageSources)) {
    if (mapped === sourceID) providers.add(providerID)
  }
  const rows: Array<[string, unknown]> = []
  for (const entry of prices) {
    const slash = entry[0].indexOf("/")
    if (slash > 0 && providers.has(entry[0].slice(0, slash))) rows.push(entry)
  }
  rows.sort(([a], [b]) => a.localeCompare(b))
  const rates = (config.tokenRates ?? []).filter((rate) => providers.has(rate.providerID))
  return JSON.stringify([rows, rates])
}

function seriesKey(sourceID: string, windowName: string): string {
  return JSON.stringify([sourceID, windowName])
}

function segmentFor(anchorAt: number): string {
  return `qseg:${anchorAt}`
}

function reasoning(
  spanMs: number,
  delta: number,
  summary: RecordSummary,
  force: string | undefined,
): string | null {
  if (force !== undefined) return force
  if (spanMs < MIN_VALUE_SPAN_MS) return VALUE_REASON_NEED_SPAN
  if (delta < MIN_VALUE_DELTA_PERCENT) return VALUE_REASON_NEED_DELTA
  if (summary.nonUsd) return VALUE_REASON_NON_USD
  if (summary.cacheIncomplete) return VALUE_REASON_CACHE
  if (summary.countsIncomplete || summary.correlationIncomplete) return VALUE_REASON_TOKENS
  if (summary.unpricedRecords > 0) return VALUE_REASON_NO_PRICES
  if (summary.pricedRecords === 0) return VALUE_REASON_NO_WORK
  return null
}

function buildApiValue(
  observedAt: number,
  anchorPercent: number,
  anchorAt: number,
  currentPercent: number,
  summary: RecordSummary,
  force: string | undefined,
): QuotaApiValue {
  const spanMs = Math.max(0, observedAt - anchorAt)
  const delta = Math.max(0, currentPercent - anchorPercent)
  const reason = reasoning(spanMs, delta, summary, force)
  const projectedRaw = reason === null && delta > 0 ? summary.usd * 100 / delta : null
  const projectedFullUSD = projectedRaw !== null && Number.isFinite(projectedRaw) && projectedRaw >= 0
    ? projectedRaw : null
  const finalReason = reason !== null ? reason : projectedFullUSD === null ? VALUE_REASON_NEED_DELTA : null
  return {
    currency: "USD",
    basis: "api-equivalent-not-billed",
    observedUSD: summary.hasPriced ? summary.usd : null,
    projectedFullUSD: finalReason === null ? projectedFullUSD : null,
    projectionStatus: finalReason === null ? "estimated" : "unavailable",
    reason: finalReason,
    trackingSince: anchorAt,
    observedAt,
    spanMs,
    quotaDeltaPercent: delta,
    records: summary.records,
    pricedRecords: summary.pricedRecords,
    unpricedRecords: summary.unpricedRecords,
    partialRecords: summary.partialRecords,
    complete: false,
  }
}

export class QuotaValueTracker {
  private readonly config: QuartermasterConfig
  private readonly buffer = new QuotaValueBuffer()
  private readonly states = new Map<string, SeriesState>()
  private readonly latest = new Map<string, QuotaApiValue>()
  // Per-series pending reanchor reason. It survives until that series commits a
  // fresh observation, so one window's recovery cannot clear another's damage.
  private readonly invalidations = new Map<string, string>()

  // Process-start clock. A first observation older than this may be missing
  // records completed before the live buffer was fed. 0 means none can exist.
  private readonly startedAt: number

  constructor(config: QuartermasterConfig, startedAt = 0) {
    this.config = config
    this.startedAt = startedAt
  }

  /** Ingest only after a token record is persisted. Ambiguous rows are kept. */
  addTokenRecord(record: TokenTelemetryRecord): void {
    if (Object.keys(this.config.usageSources).length === 0) return
    if (record.providerID === null || record.modelID === null) {
      this.buffer.add(record)
      return
    }
    if (!Object.hasOwn(this.config.usageSources, record.providerID)) return
    if (this.config.quotaExemptModels.includes(`${record.providerID}/${record.modelID}`)) return
    this.buffer.add(record)
  }

  removeTokenRecords(records: readonly TokenTelemetryRecord[]): void {
    this.buffer.remove(records.map((record) => record.hostEventID))
  }

  latestValue(sourceID: string, windowName: string): QuotaApiValue | undefined {
    return this.latest.get(seriesKey(sourceID, windowName))
  }

  async prepare(usage: UsageReadResult | undefined, now: number, prices: PriceTable): Promise<QuotaValuePlan | undefined> {
    if (usage?.status !== "ok") {
      for (const key of this.states.keys()) this.markInvalid(key, VALUE_REASON_STALE)
      return undefined
    }
    const mapping = mappingSignature(this.config)
    const rates = rateIndex(this.config.tokenRates ?? [])
    const exempt = new Set(this.config.quotaExemptModels)
    const windows = new Map<string, { sourceID: UsageSourceID; window: UsageWindow; at: number }>()
    const sourceIDs = [...new Set(Object.values(this.config.usageSources))] as UsageSourceID[]
    const pricing = new Map<string, string>()
    for (const sourceID of sourceIDs) pricing.set(sourceID, pricingSignature(this.config, prices, sourceID))
    for (const sourceID of sourceIDs) {
      const source = usage.snapshot.sources[sourceID]
      if (!source) continue
      const at = freshObservationAt(source, now)
      if (at === undefined) continue
      for (const window of source.windows) {
        if (!text(window.name) || !nonnegative(window.usedPercent) || window.usedPercent > 100) continue
        windows.set(seriesKey(sourceID, window.name), { sourceID, window, at })
      }
    }
    // A tracked window that is absent, stale, or invalid in this read is a known
    // gap. A cached or out-of-order clock is not a new observation and does not
    // invalidate; a fresh newer observation is handled lazily by valueFor.
    for (const key of this.states.keys()) {
      if (windows.get(key) === undefined) this.markInvalid(key, VALUE_REASON_STALE)
    }
    // Only spans that will actually project pin their oldest record.
    let oldest = Infinity
    for (const [key, state] of this.states) {
      if (!this.invalidations.has(key)) oldest = Math.min(oldest, state.anchorAt)
    }
    this.buffer.pruneBefore(oldest === Infinity ? Infinity : oldest)
    if (this.buffer.overflowed) {
      this.buffer.clearOverflow()
      for (const key of this.states.keys()) this.markInvalid(key, VALUE_REASON_LIMIT)
    }

    return {
      valueFor: (sourceID, windowName, at, options) => {
        const entry = windows.get(seriesKey(sourceID, windowName))
        if (entry === undefined || entry.at !== at) return undefined
        return this.planEntry(entry, mapping, pricing.get(sourceID) ?? "", prices, rates, exempt, options?.seed === true, options?.boundary === true)
      },
      recover: (sourceID, windowName, point) => this.recover(sourceID, windowName, point),
    }
  }

  private markInvalid(key: string, reason: string): void {
    const current = this.invalidations.get(key)
    if (current === VALUE_REASON_LIMIT) return
    if (current === undefined || reason === VALUE_REASON_LIMIT) this.invalidations.set(key, reason)
  }

  /**
   * Compute one observation lazily, after any head/state recovery, so a repaired
   * series cannot be valued from a plan built against stale metadata.
   */
  private planEntry(
    entry: { sourceID: UsageSourceID; window: UsageWindow; at: number },
    mapping: string,
    pricing: string,
    prices: PriceTable,
    rates: ReadonlyMap<string, TokenRateConfig>,
    exempt: ReadonlySet<string>,
    seed = false,
    boundary = false,
  ): PreparedQuotaValue {
    const { sourceID, window, at } = entry
    const windowName = window.name
    const key = seriesKey(sourceID, windowName)
    const state = this.states.get(key)
    const percent = window.usedPercent as number
    // The same observation clock is one observation, not a new one: replay the
    // committed value untouched so a re-read can neither drift as late records
    // arrive nor consume a pending invalidation that a fresh read must still see.
    if (state !== undefined && at === state.lastObservedAt) {
      return { apiValue: state.lastValue, apiValueSnapshots: [], commit: () => {} }
    }
    const pending = this.invalidations.get(key)
    const crossedReset = state !== undefined && state.lastResetsAt !== null &&
      state.lastObservedAt < state.lastResetsAt && at >= state.lastResetsAt
    const actualReset = state !== undefined && (percent < state.lastPercent || crossedReset || boundary)
    const changedBasis = state !== undefined && (state.mapping !== mapping || state.pricing !== pricing)
    const gap = state !== undefined && at - state.lastObservedAt > MAX_VALUE_OBSERVATION_GAP_MS
    const invalidated = state !== undefined && (pending !== undefined || gap)
    const reanchor = state === undefined || actualReset || changedBasis || invalidated
    const maxedNow = percent >= 100 || window.state === "rate-limited"
    const snapshots: QuotaApiValueSnapshot[] = []
    let anchorPercent: number
    let anchorAt: number
    let segmentID: string
    if (reanchor) {
      // A real reset still closes the prior segment at its frozen, already
      // published value even when the new span is invalid. The uncertain gap is
      // never priced; only the new apiValue carries the invalidation reason.
      if (actualReset) {
        snapshots.push({ event: "reset", segmentID: state!.segmentID, capturedAt: at, value: state!.lastValue })
      }
      anchorPercent = percent
      anchorAt = at
      segmentID = segmentFor(at)
    } else {
      anchorPercent = state!.anchorPercent
      anchorAt = state!.anchorAt
      segmentID = state!.segmentID
    }
    // A first observation is uncorroborated when it is an explicit seed or its
    // clock predates this process: the buffer may be missing work completed before
    // start, so the value reports a restart and the next fresh observation
    // re-anchors once the buffer is live.
    const unanchoredSeed = state === undefined && (seed || at < this.startedAt)
    const force = unanchoredSeed
      ? VALUE_REASON_RESTARTED
      : invalidated
        ? (pending ?? (gap ? VALUE_REASON_GAP : VALUE_REASON_STALE))
        : actualReset
          ? undefined
          : changedBasis ? VALUE_REASON_BASIS : undefined
    const maxTransition = maxedNow && (state === undefined || reanchor || !state.maxed)
    const summary = this.summarize(sourceID, anchorAt, at, prices, rates, exempt)
    const apiValue = buildApiValue(at, anchorPercent, anchorAt, percent, summary, force)
    if (maxTransition) {
      snapshots.push({ event: "maxed", segmentID, capturedAt: at, value: apiValue })
    }
    const next: SeriesState = {
      anchorPercent, anchorAt, segmentID,
      lastPercent: percent, lastObservedAt: at, lastResetsAt: window.resetsAt ?? null,
      lastValue: apiValue, maxed: maxedNow, mapping, pricing,
    }
    return {
      apiValue,
      apiValueSnapshots: snapshots,
      commit: () => {
        this.states.set(key, next)
        this.latest.set(key, apiValue)
        this.invalidations.delete(key)
        if (unanchoredSeed) this.markInvalid(key, VALUE_REASON_RESTARTED)
      },
    }
  }

  private summarize(
    sourceID: string,
    after: number,
    through: number,
    prices: PriceTable,
    rates: ReadonlyMap<string, TokenRateConfig>,
    exempt: ReadonlySet<string>,
  ): RecordSummary {
    const summary = emptySummary()
    const providers = new Set<string>()
    for (const [providerID, mapped] of Object.entries(this.config.usageSources)) {
      if (mapped === sourceID) providers.add(providerID)
    }
    for (const record of this.buffer.between(after, through)) {
      if (record.providerID === null || record.modelID === null) {
        summary.records += 1
        summary.unpricedRecords += 1
        summary.correlationIncomplete = true
        continue
      }
      if (!providers.has(record.providerID)) continue
      if (exempt.has(`${record.providerID}/${record.modelID}`)) continue
      summary.records += 1
      const partial = record.partial || record.usageStatus !== "reported" || record.counts === null
      if (partial) {
        summary.partialRecords += 1
        summary.countsIncomplete = true
      }
      const priced = priceRecord(record, rates, prices)
      if (!priced || priced.nonUsd) {
        summary.unpricedRecords += 1
        if (priced?.nonUsd) summary.nonUsd = true
        continue
      }
      if (priced.cacheIncomplete) summary.cacheIncomplete = true
      if (!Number.isFinite(summary.usd + priced.usd)) {
        summary.unpricedRecords += 1
        continue
      }
      summary.usd += priced.usd
      summary.pricedRecords += 1
      summary.hasPriced = true
    }
    return summary
  }

  /**
   * Re-sync an in-process tracker with a point that was already written. This
   * runs only when the series already had state, so a restart still anchors on
   * the first fresh quota read instead of replaying old archive points.
   */
  private recover(sourceID: string, windowName: string, point: QuotaValueRecovery): void {
    const key = seriesKey(sourceID, windowName)
    const state = this.states.get(key)
    if (!state || point.observedAt < state.lastObservedAt) return
    const anchorAt = point.apiValue.trackingSince ?? point.observedAt
    const anchorPercent = point.percent - (point.apiValue.quotaDeltaPercent ?? 0)
    const next: SeriesState = {
      anchorPercent,
      anchorAt,
      segmentID: segmentFor(anchorAt),
      lastPercent: point.percent,
      lastObservedAt: point.observedAt,
      lastResetsAt: point.resetsAt,
      lastValue: point.apiValue,
      maxed: point.percent >= 100 || point.state === "rate-limited",
      mapping: state.mapping,
      pricing: state.pricing,
    }
    this.states.set(key, next)
    this.latest.set(key, point.apiValue)
  }
}

function rateIndex(rates: readonly TokenRateConfig[]): Map<string, TokenRateConfig> {
  return new Map(rates.map((rate) => [
    JSON.stringify([rate.providerID, rate.modelID, rate.variant ?? null]), rate,
  ]))
}
