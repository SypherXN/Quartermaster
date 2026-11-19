import { setImmediate as yieldToHost } from "node:timers/promises"
import { freshObservationAt, type QuotaEstimate, type QuotaEstimateStatus, type QuotaEstimates } from "./quota-estimates.ts"
import {
  asQuotaApiValue, asQuotaApiValueSnapshot,
  type QuotaApiValue, type QuotaApiValueSnapshot, type QuotaValueRecovery,
} from "./quota-values.ts"
import type { UsageReadResult, UsageSourceID, UsageWindow, UsageWindowState } from "./usage.ts"

/**
 * A read-only archive of observed quota windows. Every distinct fresh
 * observation is kept for 90 days, with the forecast that was generated at that
 * moment. Older observations fold into one cumulative row per series
 * (sourceID + windowName), so the archive costs one small head row, one row per
 * observation, and at most one folded row per series.
 *
 * Closed windows are a separate, never-folded family. When a new observation
 * suggests a boundary (a percent drop or a crossed reset deadline),
 * one small row freezes what was last seen of that window, so past windows
 * survive reset and the 90-day raw fold. Only the observations on either side
 * of a boundary are known: no start or end time is invented.
 */
export const QUOTA_HISTORY_RETENTION_MS = 90 * 86_400_000
export const QUOTA_HISTORY_MAX_PAGE = 1_000
export const QUOTA_HISTORY_DEFAULT_LIMIT = 200
const MAX_TEXT = 128
const MAX_CATALOG_CURSOR = 4_096
const HOUR_MS = 3_600_000
const PAGE_SIZE = 1_000
const MIN_ESTIMATE_SPAN_MS = 15 * 60_000
const MAX_API_VALUE_SNAPSHOTS = 4

export interface QuotaHistoryObservationValue {
  apiValue: QuotaApiValue
  apiValueSnapshots?: QuotaApiValueSnapshot[]
  commit(): void
}

export interface QuotaHistoryValueSource {
  valueFor(
    sourceID: UsageSourceID,
    windowName: string,
    at: number,
    options?: { seed?: boolean; boundary?: boolean },
  ): QuotaHistoryObservationValue | undefined
  recover?(sourceID: UsageSourceID, windowName: string, point: QuotaValueRecovery): void
}

const SERIES_PREFIX = "routing/quota-history-v1/series/"
const POINT_PREFIX = "routing/quota-history-v1/points/"
const CUMULATIVE_PREFIX = "routing/quota-history-v1/cumulative/"
const WINDOW_PREFIX = "routing/quota-history-v1/windows/"

const STATUSES: readonly QuotaEstimateStatus[] = [
  "estimated", "insufficient-history", "no-recent-usage", "stale", "cutoff-reached",
]
const STATES: readonly UsageWindowState[] = ["ok", "rate-limited", "unknown"]

export interface QuotaHistoryPoint {
  version: 1
  sourceID: string
  windowName: string
  observedAt: number
  percent: number
  state: UsageWindowState
  resetsAt: number | null
  resetEstimated: boolean
  cycleBoundary: boolean
  estimate: QuotaEstimate
  apiValue?: QuotaApiValue
  apiValueSnapshots?: QuotaApiValueSnapshot[]
  /** First durable observation of this cycle, not the provider's start time. */
  instanceAnchorAt?: number
}

/**
 * One observed boundary, not proof of a provider reset. Its evidence falls between
 * `lastObservedAt` and `nextObservedAt`; nothing finer is known. `deadlineCrossed`:
 * true means the reported reset deadline fell inside that gap (an estimated
 * deadline when `resetEstimated`); false means only the percentage dropped, which
 * a rolling window also does without any reset, so treat it as inferred.
 * `nextObservedAt` is the observation that proved the boundary. If that
 * observation's point failed to persist, the first durable point of the new cycle
 * may be a later one: the row is frozen the moment it is written.
 * `apiValue` is the previous durable point's value verbatim, absent when unknown.
 * The sole window amount is `finalEstimate.projectedFullUSD`: the last valid
 * pre-boundary projection, with its original observation clock. Absence means
 * unavailable, never zero. `apiValue` is compatibility metadata only.
 */
export interface QuotaHistoryWindow {
  version: 1
  sourceID: string
  windowName: string
  lastObservedAt: number
  nextObservedAt: number
  lastPercent: number
  nextPercent: number
  resetsAt: number | null
  resetEstimated: boolean
  nextResetsAt: number | null
  deadlineCrossed: boolean
  apiValue?: QuotaApiValue
  finalEstimate?: QuotaApiValue
  instanceAnchorAt?: number
  finalEstimateReason?: string
}

export interface QuotaCurrentCheckpoint {
  instanceAnchorAt: number
  observedAt: number
  apiValue?: QuotaApiValue
}

interface StatBlock {
  min: number | null
  max: number | null
  sum: number
  count: number
}

export interface QuotaHistoryApiValueTotals {
  basis: "closed-reset-segments-only"
  apiValuePoints: number
  unpricedApiValuePoints: number
  estimatedProjections: number
  projectedMinUSD: number | null
  projectedMaxUSD: number | null
  closedResetSegments: number
  closedObservedUSD: number
  closedObservedUSDComplete: boolean
  maxedSnapshots: number
}

export interface QuotaHistoryCumulative {
  sourceID: string
  windowName: string
  committedThrough: number
  observations: number
  cycleBoundaries: number
  firstObservedAt: number | null
  lastObservedAt: number | null
  percentMin: number | null
  percentMax: number | null
  percentLast: number | null
  statusCounts: Record<QuotaEstimateStatus, number>
  rate: StatBlock
  leadMs: StatBlock
  spanMs: StatBlock
  sampleCount: StatBlock
  updatedAt: number
  apiValue?: QuotaHistoryApiValueTotals
}

export interface QuotaHistoryCatalogEntry {
  sourceID: string
  windowName: string
  lastObservedAt: number
  lastPercent: number
  lastResetsAt: number | null
  lastResetEstimated: boolean
  hasCumulative: boolean
  cumulativeThrough: number | null
}

export interface QuotaHistoryMetadata {
  rawRetentionMs: number
  rawSince: number
  pageSize: number
  pointScope: "one source and window per query"
  cumulativeBasis: "lifetime before raw retention; from/to apply to raw points only"
    | "not applicable to closed-window queries"
  /** "windows": from, to and cursor apply to each row's lastObservedAt. */
  rangeAppliesTo: "points" | "windows"
  retentionMaintenance: "folds before every read; batches hourly on record"
    | "closed windows are kept indefinitely; a window query never folds or deletes"
  closedRetention?: "indefinite"
}

export interface QuotaHistoryQuery {
  /** Default "points". "windows" needs sourceID and windowName. */
  kind?: "points" | "windows"
  sourceID?: string
  windowName?: string
  from?: number
  to?: number
  limit?: number
  cursor?: string
  catalogCursor?: string
}

export interface QuotaHistoryResult {
  status: "ok"
  catalog: QuotaHistoryCatalogEntry[]
  points: QuotaHistoryPoint[]
  /** Present only for a kind:"windows" query. */
  windows?: QuotaHistoryWindow[]
  nextCursor: string | null
  nextCatalogCursor: string | null
  cumulative: QuotaHistoryCumulative | null
  metadata: QuotaHistoryMetadata
}

export type QuotaHistoryQueryResult = QuotaHistoryResult | { status: "unavailable"; reason: "storage-unavailable" }

interface Head {
  sourceID: string
  windowName: string
  lastObservedAt: number
  lastPercent: number
  lastResetsAt: number | null
  lastResetEstimated: boolean
  /** Latest valid projection in this cycle, even if later points cannot project. */
  latestEstimate?: QuotaApiValue
  instanceAnchorAt: number
  currentValue?: QuotaApiValue
}

interface StoredCumulative extends QuotaHistoryCumulative {
  version: 1
}

type Storage = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove?(key: string): Promise<void>
  scan?(options: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: ReadonlyArray<{ key: string; value: unknown }>
    next?: string
  }>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown, max = MAX_TEXT): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
const whole = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const encodeSeries = (sourceID: string, windowName: string) =>
  encodeURIComponent(JSON.stringify([sourceID, windowName]))
const seriesKey = (sourceID: string, windowName: string) => `${SERIES_PREFIX}${encodeSeries(sourceID, windowName)}`
const cumulativeKey = (sourceID: string, windowName: string) => `${CUMULATIVE_PREFIX}${encodeSeries(sourceID, windowName)}`
const pointPrefix = (sourceID: string, windowName: string) => `${POINT_PREFIX}${encodeSeries(sourceID, windowName)}/`
// Fixed width keeps point keys in numeric timestamp order for scan/after.
const pad = (at: number) => String(at).padStart(16, "0")
const pointKey = (sourceID: string, windowName: string, at: number) => `${pointPrefix(sourceID, windowName)}${pad(at)}`
const windowPrefix = (sourceID: string, windowName: string) => `${WINDOW_PREFIX}${encodeSeries(sourceID, windowName)}/`
// Keyed by the last observation in the closed window: one boundary, one key, so a
// retried write after any failure lands on the same row instead of adding another.
const windowKey = (sourceID: string, windowName: string, lastObservedAt: number) =>
  `${windowPrefix(sourceID, windowName)}${pad(lastObservedAt)}`

const emptyStatusCounts = (): Record<QuotaEstimateStatus, number> => ({
  estimated: 0, "insufficient-history": 0, "no-recent-usage": 0, stale: 0, "cutoff-reached": 0,
})
const emptyStat = (): StatBlock => ({ min: null, max: null, sum: 0, count: 0 })

const emptyApiValueTotals = (): QuotaHistoryApiValueTotals => ({
  basis: "closed-reset-segments-only",
  apiValuePoints: 0,
  unpricedApiValuePoints: 0,
  estimatedProjections: 0,
  projectedMinUSD: null,
  projectedMaxUSD: null,
  closedResetSegments: 0,
  closedObservedUSD: 0,
  closedObservedUSDComplete: true,
  maxedSnapshots: 0,
})

function asApiValueTotals(value: unknown): QuotaHistoryApiValueTotals | undefined {
  if (!isRecord(value) || value.basis !== "closed-reset-segments-only") return undefined
  if (!whole(value.apiValuePoints) || !whole(value.unpricedApiValuePoints) ||
    !whole(value.estimatedProjections) || !whole(value.closedResetSegments) ||
    !whole(value.maxedSnapshots) || typeof value.closedObservedUSDComplete !== "boolean") return undefined
  if (!nonnegative(value.closedObservedUSD)) return undefined
  if (!(value.projectedMinUSD === null || nonnegative(value.projectedMinUSD))) return undefined
  if (!(value.projectedMaxUSD === null || nonnegative(value.projectedMaxUSD))) return undefined
  return {
    basis: "closed-reset-segments-only",
    apiValuePoints: value.apiValuePoints,
    unpricedApiValuePoints: value.unpricedApiValuePoints,
    estimatedProjections: value.estimatedProjections,
    projectedMinUSD: value.projectedMinUSD as number | null,
    projectedMaxUSD: value.projectedMaxUSD as number | null,
    closedResetSegments: value.closedResetSegments,
    closedObservedUSD: value.closedObservedUSD,
    closedObservedUSDComplete: value.closedObservedUSDComplete,
    maxedSnapshots: value.maxedSnapshots,
  }
}

function addStat(block: StatBlock, value: number | undefined): void {
  if (value === undefined || !Number.isFinite(value)) return
  block.min = block.min === null ? value : Math.min(block.min, value)
  block.max = block.max === null ? value : Math.max(block.max, value)
  block.sum += value
  block.count += 1
}

function asEstimate(value: unknown): QuotaEstimate | undefined {
  if (!isRecord(value) || !STATUSES.includes(value.status as QuotaEstimateStatus)) return undefined
  if (!nonnegative(value.cutoffPercent) || value.cutoffPercent > 100) return undefined
  if (!whole(value.sampleCount) || !whole(value.spanMs)) return undefined
  const status = value.status as QuotaEstimateStatus
  // The estimator only attaches a rate and a cutoff to a real projection.
  // Anything else is malformed stored data, not a forecast to trust or fold.
  if (value.ratePerMinute !== undefined && !(finite(value.ratePerMinute) && value.ratePerMinute > 0)) return undefined
  if (value.cutoffAt !== undefined && !nonnegative(value.cutoffAt)) return undefined
  if (status === "estimated") {
    if (value.ratePerMinute === undefined || value.cutoffAt === undefined) return undefined
    if (value.sampleCount < 2 || value.spanMs < MIN_ESTIMATE_SPAN_MS) return undefined
  } else if (value.ratePerMinute !== undefined || value.cutoffAt !== undefined) return undefined
  const estimate: QuotaEstimate = {
    status,
    cutoffPercent: value.cutoffPercent,
    sampleCount: value.sampleCount,
    spanMs: value.spanMs,
  }
  if (value.ratePerMinute !== undefined) estimate.ratePerMinute = value.ratePerMinute as number
  if (value.cutoffAt !== undefined) estimate.cutoffAt = value.cutoffAt as number
  return estimate
}

function asPoint(value: unknown): QuotaHistoryPoint | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  if (!text(value.sourceID) || !text(value.windowName) || !whole(value.observedAt)) return undefined
  if (!nonnegative(value.percent) || value.percent > 100 || !STATES.includes(value.state as UsageWindowState)) return undefined
  if (!(value.resetsAt === null || whole(value.resetsAt))) return undefined
  if (typeof value.resetEstimated !== "boolean" || typeof value.cycleBoundary !== "boolean") return undefined
  const estimate = asEstimate(value.estimate)
  if (!estimate) return undefined
  // New optional fields never make an otherwise valid quota observation vanish.
  let apiValue = value.apiValue === undefined ? undefined : asQuotaApiValue(value.apiValue)
  if (apiValue && apiValue.observedAt !== value.observedAt) apiValue = undefined
  let apiValueSnapshots: QuotaApiValueSnapshot[] | undefined
  if (Array.isArray(value.apiValueSnapshots) && value.apiValueSnapshots.length <= MAX_API_VALUE_SNAPSHOTS) {
    const snapshots = value.apiValueSnapshots.map((snapshot) => asQuotaApiValueSnapshot(snapshot))
    if (snapshots.every((snapshot) => snapshot !== undefined)) apiValueSnapshots = snapshots as QuotaApiValueSnapshot[]
  }
  return {
    version: 1,
    sourceID: value.sourceID,
    windowName: value.windowName,
    observedAt: value.observedAt,
    percent: value.percent,
    state: value.state as UsageWindowState,
    resetsAt: value.resetsAt as number | null,
    resetEstimated: value.resetEstimated,
    cycleBoundary: value.cycleBoundary,
    estimate,
    ...(apiValue === undefined ? {} : { apiValue }),
    ...(apiValueSnapshots === undefined ? {} : { apiValueSnapshots }),
    ...(whole(value.instanceAnchorAt) && value.instanceAnchorAt <= value.observedAt
      ? { instanceAnchorAt: value.instanceAnchorAt } : {}),
  }
}

function asHead(value: unknown): Head | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  if (!text(value.sourceID) || !text(value.windowName) || !whole(value.lastObservedAt)) return undefined
  if (!nonnegative(value.lastPercent) || value.lastPercent > 100) return undefined
  if (!(value.lastResetsAt === null || whole(value.lastResetsAt))) return undefined
  if (typeof value.lastResetEstimated !== "boolean") return undefined
  // A damaged estimate only loses the estimate, never the head or the series.
  const latestEstimate = asProjection(value.latestEstimate, value.lastObservedAt)
  const instanceAnchorAt = whole(value.instanceAnchorAt) && value.instanceAnchorAt <= value.lastObservedAt
    ? value.instanceAnchorAt : value.lastObservedAt
  const currentValue = asQuotaApiValue(value.currentValue)
  return {
    sourceID: value.sourceID,
    windowName: value.windowName,
    lastObservedAt: value.lastObservedAt,
    lastPercent: value.lastPercent,
    lastResetsAt: value.lastResetsAt as number | null,
    lastResetEstimated: value.lastResetEstimated,
    ...(latestEstimate === undefined ? {} : { latestEstimate }),
    instanceAnchorAt,
    ...(currentValue?.observedAt === value.lastObservedAt ? { currentValue } : {}),
  }
}

function asProjection(value: unknown, through: number): QuotaApiValue | undefined {
  const projection = asQuotaApiValue(value)
  return projection?.projectionStatus === "estimated" && projection.projectedFullUSD !== null &&
    projection.observedAt <= through ? projection : undefined
}

// A row that contradicts its own evidence is malformed, not a window to trust.
function asWindow(value: unknown): QuotaHistoryWindow | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  if (!text(value.sourceID) || !text(value.windowName)) return undefined
  if (!whole(value.lastObservedAt) || !whole(value.nextObservedAt) || value.nextObservedAt <= value.lastObservedAt) return undefined
  if (!nonnegative(value.lastPercent) || value.lastPercent > 100) return undefined
  if (!nonnegative(value.nextPercent) || value.nextPercent > 100) return undefined
  if (!(value.resetsAt === null || whole(value.resetsAt))) return undefined
  if (!(value.nextResetsAt === null || whole(value.nextResetsAt))) return undefined
  if (typeof value.resetEstimated !== "boolean" || typeof value.deadlineCrossed !== "boolean") return undefined
  if (value.deadlineCrossed) {
    if (value.resetsAt === null || value.resetsAt <= value.lastObservedAt || value.resetsAt > value.nextObservedAt) return undefined
  } else if (value.nextPercent >= value.lastPercent) return undefined
  let apiValue = value.apiValue === undefined ? undefined : asQuotaApiValue(value.apiValue)
  if (apiValue && apiValue.observedAt !== value.lastObservedAt) apiValue = undefined
  const finalEstimate = asProjection(value.finalEstimate, value.lastObservedAt)
  const finalEstimateReason = finalEstimate ? undefined
    : text(value.finalEstimateReason, 160) && !/[\u0000-\u001f\u007f]/.test(value.finalEstimateReason)
      ? value.finalEstimateReason : apiValue?.reason ?? "No estimate recorded"
  return {
    version: 1,
    sourceID: value.sourceID,
    windowName: value.windowName,
    lastObservedAt: value.lastObservedAt,
    nextObservedAt: value.nextObservedAt,
    lastPercent: value.lastPercent,
    nextPercent: value.nextPercent,
    resetsAt: value.resetsAt as number | null,
    resetEstimated: value.resetEstimated,
    nextResetsAt: value.nextResetsAt as number | null,
    deadlineCrossed: value.deadlineCrossed,
    ...(apiValue === undefined ? {} : { apiValue }),
    ...(finalEstimate === undefined ? {} : { finalEstimate }),
    ...(whole(value.instanceAnchorAt) && value.instanceAnchorAt <= value.lastObservedAt
      ? { instanceAnchorAt: value.instanceAnchorAt } : {}),
    ...(finalEstimateReason === undefined ? {} : { finalEstimateReason }),
  }
}

function asStat(value: unknown): StatBlock | undefined {
  if (!isRecord(value)) return undefined
  if (!(value.min === null || finite(value.min)) || !(value.max === null || finite(value.max))) return undefined
  if (!finite(value.sum) || !whole(value.count)) return undefined
  return { min: value.min as number | null, max: value.max as number | null, sum: value.sum, count: value.count }
}

function asCumulative(value: unknown): QuotaHistoryCumulative | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  if (!text(value.sourceID) || !text(value.windowName) || !whole(value.committedThrough)) return undefined
  if (!whole(value.observations) || !whole(value.cycleBoundaries) || !whole(value.updatedAt)) return undefined
  if (!(value.firstObservedAt === null || whole(value.firstObservedAt))) return undefined
  if (!(value.lastObservedAt === null || whole(value.lastObservedAt))) return undefined
  if (!(value.percentMin === null || nonnegative(value.percentMin)) ||
    !(value.percentMax === null || nonnegative(value.percentMax)) ||
    !(value.percentLast === null || nonnegative(value.percentLast))) return undefined
  if (!isRecord(value.statusCounts)) return undefined
  const statusCounts = emptyStatusCounts()
  for (const status of STATUSES) {
    if (!whole(value.statusCounts[status])) return undefined
    statusCounts[status] = value.statusCounts[status] as number
  }
  const rate = asStat(value.rate)
  const leadMs = asStat(value.leadMs)
  const spanMs = asStat(value.spanMs)
  const sampleCount = asStat(value.sampleCount)
  if (!rate || !leadMs || !spanMs || !sampleCount) return undefined
  let apiValue: QuotaHistoryApiValueTotals | undefined
  if (value.apiValue !== undefined) {
    apiValue = asApiValueTotals(value.apiValue)
    if (!apiValue) return undefined
  }
  return {
    sourceID: value.sourceID,
    windowName: value.windowName,
    committedThrough: value.committedThrough,
    observations: value.observations,
    cycleBoundaries: value.cycleBoundaries,
    firstObservedAt: value.firstObservedAt as number | null,
    lastObservedAt: value.lastObservedAt as number | null,
    percentMin: value.percentMin as number | null,
    percentMax: value.percentMax as number | null,
    percentLast: value.percentLast as number | null,
    statusCounts,
    rate, leadMs, spanMs, sampleCount,
    updatedAt: value.updatedAt,
    ...(apiValue === undefined ? {} : { apiValue }),
  }
}

function emptyCumulative(sourceID: string, windowName: string): StoredCumulative {
  return {
    version: 1,
    sourceID,
    windowName,
    committedThrough: 0,
    observations: 0,
    cycleBoundaries: 0,
    firstObservedAt: null,
    lastObservedAt: null,
    percentMin: null,
    percentMax: null,
    percentLast: null,
    statusCounts: emptyStatusCounts(),
    rate: emptyStat(),
    leadMs: emptyStat(),
    spanMs: emptyStat(),
    sampleCount: emptyStat(),
    updatedAt: 0,
    apiValue: emptyApiValueTotals(),
  }
}

// The one place a folded point touches the cumulative row. Money is added only
// once, from the frozen value of a closed reset segment. Max snapshots and
// projected values are coverage statistics, never additive spend.
function addApiValueTotals(row: StoredCumulative, point: QuotaHistoryPoint): void {
  const totals = row.apiValue ?? emptyApiValueTotals()
  row.apiValue = totals
  if (point.apiValue) {
    totals.apiValuePoints += 1
    if (point.apiValue.observedUSD === null) totals.unpricedApiValuePoints += 1
    if (point.apiValue.projectionStatus === "estimated" && point.apiValue.projectedFullUSD !== null) {
      totals.estimatedProjections += 1
      totals.projectedMinUSD = totals.projectedMinUSD === null
        ? point.apiValue.projectedFullUSD : Math.min(totals.projectedMinUSD, point.apiValue.projectedFullUSD)
      totals.projectedMaxUSD = totals.projectedMaxUSD === null
        ? point.apiValue.projectedFullUSD : Math.max(totals.projectedMaxUSD, point.apiValue.projectedFullUSD)
    }
  }
  for (const snapshot of point.apiValueSnapshots ?? []) {
    if (snapshot.event === "maxed") {
      totals.maxedSnapshots += 1
      continue
    }
    totals.closedResetSegments += 1
    // A closed snapshot is only a complete monetary total if the snapshot itself
    // says so. This feature's frozen values are always approximate/incomplete.
    if (!snapshot.value.complete) totals.closedObservedUSDComplete = false
    if (snapshot.value.observedUSD === null) totals.closedObservedUSDComplete = false
    else totals.closedObservedUSD += snapshot.value.observedUSD
  }
}

// The one place a folded point touches the cumulative row.
function addToCumulative(row: StoredCumulative, point: QuotaHistoryPoint): void {
  row.observations += 1
  if (point.cycleBoundary) row.cycleBoundaries += 1
  row.firstObservedAt = row.firstObservedAt === null ? point.observedAt : Math.min(row.firstObservedAt, point.observedAt)
  row.lastObservedAt = row.lastObservedAt === null ? point.observedAt : Math.max(row.lastObservedAt, point.observedAt)
  row.percentMin = row.percentMin === null ? point.percent : Math.min(row.percentMin, point.percent)
  row.percentMax = row.percentMax === null ? point.percent : Math.max(row.percentMax, point.percent)
  row.percentLast = point.percent
  row.statusCounts[point.estimate.status] += 1
  addStat(row.rate, point.estimate.ratePerMinute)
  addStat(row.leadMs, point.estimate.cutoffAt === undefined ? undefined : point.estimate.cutoffAt - point.observedAt)
  addStat(row.spanMs, point.estimate.spanMs)
  addStat(row.sampleCount, point.estimate.sampleCount)
  addApiValueTotals(row, point)
}

export class QuotaHistory {
  private readonly storage: Storage
  private readonly clock: () => number
  private heads = new Map<string, Head>()
  private missing = new Set<string>()
  // Last observation clock already valued per series, so a cached clock is seeded once.
  private seeded = new Map<string, number>()
  private pending = Promise.resolve()
  private lastCompactedAt: number | undefined

  constructor(storage: Storage, now: () => number = Date.now) {
    this.storage = storage
    this.clock = now
  }

  /**
   * Record the fresh observations in one usage read. Callers must have called
   * `estimates.observe` first: the archived forecast is the one that observation
   * actually produced. `sourceIDs` limits the archive to configured sources.
   */
  record(
    usage: UsageReadResult | undefined,
    estimates: QuotaEstimates,
    now = this.clock(),
    sourceIDs?: ReadonlySet<UsageSourceID>,
    values?: QuotaHistoryValueSource,
  ): Promise<boolean> {
    if (!this.readable()) return Promise.resolve(false)
    return this.serialize(async () => {
      let changed = false
      if (usage?.status === "ok") {
        for (const [rawSourceID, source] of Object.entries(usage.snapshot.sources)) {
          if (!source) continue
          const sourceID = rawSourceID as UsageSourceID
          if (sourceIDs !== undefined && !sourceIDs.has(sourceID)) continue
          const at = freshObservationAt(source, now)
          if (at === undefined) continue
          for (const window of source.windows) {
            if (!text(window.name)) continue
            if (!nonnegative(window.usedPercent) || window.usedPercent > 100) continue
            changed = await this.append(sourceID, window, at, estimates, now, values) || changed
          }
        }
      }
      await this.maybeCompactLocked(now)
      return changed
    })
  }

  /** Fold everything older than the raw retention window. Safe to call directly. */
  compact(now = this.clock()): Promise<void> {
    if (!this.readable()) return Promise.resolve()
    return this.serialize(() => this.compactLocked(now))
  }

  /** Exact-clock, read-only durable head view. Never repairs, seeds, folds or prices. */
  currentCheckpoint(sourceID: string, windowName: string, at: number): Promise<QuotaCurrentCheckpoint | undefined> {
    return this.serialize(async () => {
      try {
        const head = asHead(await this.storage.get(seriesKey(sourceID, windowName)))
        if (!head || head.sourceID !== sourceID || head.windowName !== windowName || head.lastObservedAt !== at) return undefined
        // A closure can be durable before its proving point/head. That instance
        // is already closed, even when the caller still holds the old clock.
        if (await this.storage.get(windowKey(sourceID, windowName, at)) !== undefined) return undefined
        return {
          instanceAnchorAt: head.instanceAnchorAt, observedAt: at,
          ...(head.currentValue === undefined ? {} : { apiValue: head.currentValue }),
        }
      } catch { return undefined }
    })
  }

  /** Paginated raw points for one series, plus the folded lifetime summary. */
  query(input: QuotaHistoryQuery = {}): Promise<QuotaHistoryQueryResult> {
    if (!this.readable()) return Promise.resolve({ status: "unavailable", reason: "storage-unavailable" })
    return this.serialize(async () => {
      const now = this.clock()
      const limit = Math.min(QUOTA_HISTORY_MAX_PAGE, Math.max(1, Math.floor(input.limit ?? QUOTA_HISTORY_DEFAULT_LIMIT)))
      if (input.kind === "windows") {
        // Closed windows are never folded, so this read does no maintenance and
        // cannot fail because of it. It needs exactly one series.
        if (input.sourceID === undefined || input.windowName === undefined) {
          return { status: "unavailable", reason: "storage-unavailable" }
        }
        try {
          const rows = await this.pageRows(
            windowPrefix(input.sourceID, input.windowName), asWindow,
            (row) => windowKey(row.sourceID, row.windowName, row.lastObservedAt),
            (row) => row.lastObservedAt, input, limit,
          )
          const page = rows.length > limit ? rows.slice(0, limit) : rows
          return {
            status: "ok", catalog: [], points: [], windows: page,
            nextCursor: rows.length > limit && page.length > 0 ? String(page[page.length - 1].lastObservedAt) : null,
            nextCatalogCursor: null, cumulative: null,
            metadata: {
              rawRetentionMs: QUOTA_HISTORY_RETENTION_MS,
              rawSince: now - QUOTA_HISTORY_RETENTION_MS,
              pageSize: limit,
              pointScope: "one source and window per query",
              cumulativeBasis: "not applicable to closed-window queries",
              rangeAppliesTo: "windows",
              retentionMaintenance: "closed windows are kept indefinitely; a window query never folds or deletes",
              closedRetention: "indefinite",
            },
          }
        } catch {
          return { status: "unavailable", reason: "storage-unavailable" }
        }
      }
      // A read is a retention boundary: never return a raw point older than the
      // advertised window because an hourly batch has not run yet. Fold failures
      // are answered as unavailable, never by treating a checkpoint as absent.
      try {
        await this.compactLocked(now)
        this.lastCompactedAt = now
      } catch {
        return { status: "unavailable", reason: "storage-unavailable" }
      }
      const metadata: QuotaHistoryMetadata = {
        rawRetentionMs: QUOTA_HISTORY_RETENTION_MS,
        rawSince: now - QUOTA_HISTORY_RETENTION_MS,
        pageSize: limit,
        pointScope: "one source and window per query",
        cumulativeBasis: "lifetime before raw retention; from/to apply to raw points only",
        rangeAppliesTo: "points",
        retentionMaintenance: "folds before every read; batches hourly on record",
      }
      if (input.sourceID === undefined || input.windowName === undefined) {
        const page = await this.catalogPage(input.catalogCursor, limit)
        return {
          status: "ok", catalog: page.catalog, points: [], nextCursor: null,
          nextCatalogCursor: page.nextCatalogCursor, cumulative: null, metadata,
        }
      }
      const cumulative = await this.loadCumulative(input.sourceID, input.windowName)
        .catch(() => undefined)
      if (cumulative === undefined) return { status: "unavailable", reason: "storage-unavailable" }
      const points = await this.pageRows(
        pointPrefix(input.sourceID, input.windowName), asPoint,
        (point) => pointKey(point.sourceID, point.windowName, point.observedAt),
        (point) => point.observedAt, input, limit,
      )
      const page = points.length > limit ? points.slice(0, limit) : points
      const nextCursor = points.length > limit && page.length > 0
        ? String(page[page.length - 1].observedAt)
        : null
      return {
        status: "ok", catalog: [], points: page, nextCursor,
        nextCatalogCursor: null, cumulative, metadata,
      }
    })
  }

  private readable(): boolean {
    return typeof this.storage.scan === "function" && typeof this.storage.remove === "function"
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pending.catch(() => {}).then(operation)
    this.pending = task.then(() => {}, () => {})
    return task
  }

  /**
   * One bounded page of rows under a series prefix, ordered by their padded
   * timestamp key. Collects limit + 1 so the caller knows whether another page
   * exists. A malformed row, or one whose key does not match its content, is
   * skipped, never deleted.
   */
  private async pageRows<T>(
    prefix: string,
    parse: (value: unknown) => T | undefined,
    keyOf: (row: T) => string,
    atOf: (row: T) => number,
    input: QuotaHistoryQuery,
    limit: number,
  ): Promise<T[]> {
    const collected: T[] = []
    const cursor = input.cursor === undefined ? undefined : Number(input.cursor)
    let after = cursor !== undefined
      ? prefix + pad(cursor)
      : input.from !== undefined && input.from > 0 ? prefix + pad(input.from - 1) : undefined
    let exhausted = false
    while (!exhausted && collected.length <= limit) {
      const page = await this.scanPage(prefix, after)
      for (const entry of page.entries) {
        const row = parse(entry.value)
        if (row === undefined || entry.key !== keyOf(row)) continue
        const at = atOf(row)
        if (input.from !== undefined && at < input.from) continue
        if (input.to !== undefined && at > input.to) { exhausted = true; break }
        collected.push(row)
        if (collected.length > limit) { exhausted = true; break }
      }
      if (!exhausted) {
        if (!page.next || page.next === after) exhausted = true
        else {
          after = page.next
          await yieldToHost()
        }
      }
    }
    return collected
  }

  /** Read-only catalog view: an unreadable or malformed row only hides the fold summary. */
  private async readCumulative(sourceID: string, windowName: string): Promise<QuotaHistoryCumulative | null> {
    try {
      const value = await this.storage.get(cumulativeKey(sourceID, windowName))
      return value === undefined ? null : this.parseCumulative(value, sourceID, windowName)
    } catch {
      return null
    }
  }

  /**
   * Compaction view: a read failure or malformed/mismatched checkpoint aborts the
   * fold. Destructive work must never run as if the checkpoint were absent.
   */
  private async loadCumulative(sourceID: string, windowName: string): Promise<QuotaHistoryCumulative | null> {
    const value = await this.storage.get(cumulativeKey(sourceID, windowName))
    if (value === undefined) return null
    const row = this.parseCumulative(value, sourceID, windowName)
    if (!row) throw new Error("Quota history cumulative row is malformed")
    return row
  }

  private parseCumulative(value: unknown, sourceID: string, windowName: string): QuotaHistoryCumulative | null {
    const row = asCumulative(value)
    if (!row || row.sourceID !== sourceID || row.windowName !== windowName) return null
    return row
  }

  private async catalogPage(
    cursor: string | undefined,
    limit: number,
  ): Promise<{ catalog: QuotaHistoryCatalogEntry[]; nextCatalogCursor: string | null }> {
    const heads = (await this.scanHeads())
      .sort((left, right) => {
        const a = encodeSeries(left.head.sourceID, left.head.windowName)
        const b = encodeSeries(right.head.sourceID, right.head.windowName)
        return a < b ? -1 : a > b ? 1 : 0
      })
    const ordered = cursor === undefined
      ? heads
      : heads.filter(({ head }) => encodeSeries(head.sourceID, head.windowName) > cursor)
    const page = ordered.slice(0, limit)
    const catalog: QuotaHistoryCatalogEntry[] = []
    for (const { head } of page) {
      const cumulative = await this.readCumulative(head.sourceID, head.windowName)
      catalog.push({
        sourceID: head.sourceID,
        windowName: head.windowName,
        lastObservedAt: head.lastObservedAt,
        lastPercent: head.lastPercent,
        lastResetsAt: head.lastResetsAt,
        lastResetEstimated: head.lastResetEstimated,
        hasCumulative: cumulative !== null,
        cumulativeThrough: cumulative?.committedThrough ?? null,
      })
    }
    const nextCatalogCursor = ordered.length > page.length && page.length > 0
      ? encodeSeries(page[page.length - 1].head.sourceID, page[page.length - 1].head.windowName)
      : null
    return { catalog, nextCatalogCursor }
  }

  private async append(
    sourceID: UsageSourceID,
    window: UsageWindow,
    at: number,
    estimates: QuotaEstimates,
    now: number,
    values?: QuotaHistoryValueSource,
  ): Promise<boolean> {
    const windowName = window.name
    const key = seriesKey(sourceID, windowName)
    let head = this.heads.get(key)
    if (head === undefined && !this.missing.has(key)) {
      head = asHead(await this.storage.get(key))
      if (head) this.heads.set(key, head)
      else this.missing.add(key)
    }
    // An out-of-order read is one older observation, not a new point.
    if (head !== undefined && at < head.lastObservedAt) return false
    // A cached snapshot re-reports the same clock: never a new point, but after a
    // restart this is the first time this process sees the observation, so the
    // tracker must still be seeded or the live value would read "not tracked yet".
    if (head !== undefined && at === head.lastObservedAt) {
      await this.seedObservation(sourceID, windowName, at, key, values)
      return false
    }

    // A crash between the point write and the head write leaves the original
    // point behind. Repair the head from the newest written point before a newer
    // observation, so a boundary is not replayed against stale metadata.
    head = await this.repairHead(sourceID, windowName, head, at, key, values)

    const existing = await this.existingPoint(sourceID, windowName, at)
    if (existing !== undefined) {
      if (existing.apiValue !== undefined) values?.recover?.(sourceID, windowName, { ...existing, apiValue: existing.apiValue })
      const recovered = this.headFromPoint(existing, head)
      await this.storage.set(key, { version: 1, ...recovered })
      this.heads.set(key, recovered)
      this.missing.delete(key)
      // The point survived a crash (or predates apiValue); value it now so the
      // tracker commits this observation instead of waiting for the next one.
      await this.seedObservation(sourceID, windowName, at, key, values)
      return false
    }

    const percent = window.usedPercent as number
    // The stable series is source + window. A cycle boundary needs a percentage
    // drop or the single observation that crosses the previous reset deadline;
    // later reads with that same past deadline are the same cycle.
    const crossedReset = head !== undefined && head.lastResetsAt !== null &&
      head.lastObservedAt < head.lastResetsAt && head.lastResetsAt <= at
    const natural = head !== undefined && (percent < head.lastPercent || crossedReset)
    const estimate = estimates.estimate(sourceID, window, now)
    if (!estimate) return false

    // A closed window is durable before the point that proves it, and that point
    // is durable before the head. A row already stored at the previous head's key
    // is a closure that happened (the observation proving it may never have become
    // a point): the next durable point is the first of the new cycle, and the row
    // is never rewritten. This must come after the out-of-order, same-clock and
    // existing-point exits above: those never close a window.
    let pending = false
    if (head !== undefined) {
      const closure = await this.closure(head, at)
      if (closure === "older") return false
      pending = closure === "pending"
    }
    const cycleBoundary = natural || pending
    // The previous durable point can hold a projection the head never saw (a seed
    // enriched it afterwards). A failed read only matters when it would freeze a
    // new row, because that row must not be built from a guess.
    const previous = head === undefined ? undefined : await this.previousPoint(head, natural && !pending)
    const settledHead = head === undefined ? undefined : this.withProjection(head, previous)
    // Value after the closure is known so the tracker closes its own segment too.
    const prepared = values?.valueFor(sourceID, windowName, at, { boundary: cycleBoundary })
    const point: QuotaHistoryPoint = {
      version: 1,
      sourceID,
      windowName,
      observedAt: at,
      percent,
      state: window.state,
      resetsAt: window.resetsAt ?? null,
      resetEstimated: window.resetEstimated === true,
      cycleBoundary,
      instanceAnchorAt: cycleBoundary ? at : head?.instanceAnchorAt ?? at,
      estimate,
      ...(prepared === undefined ? {} : { apiValue: prepared.apiValue }),
      ...(prepared?.apiValueSnapshots?.length ? { apiValueSnapshots: prepared.apiValueSnapshots } : {}),
    }
    if (natural && !pending && settledHead !== undefined) {
      await this.settleWindow(settledHead, previous, point, crossedReset)
    }
    const next = this.headFromPoint(point, settledHead)
    // Point first, head second: a crash between the two leaves the point behind,
    // and the next attempt reuses it and recovers the head from it.
    await this.storage.set(pointKey(sourceID, windowName, at), point)
    await this.storage.set(key, {
      version: 1, ...next,
    })
    this.heads.set(key, next)
    this.missing.delete(key)
    prepared?.commit()
    if (prepared !== undefined) this.seeded.set(key, at)
    return true
  }

  /**
   * Value an observation that is already archived (same clock after a restart, or
   * a point that survived a crash). The tracker is committed so the live window
   * has a value; existing point money stays frozen. The head checkpoints that
   * durable value before status can display it. Recovery never resumes aggregation.
   */
  private async seedObservation(
    sourceID: UsageSourceID,
    windowName: string,
    at: number,
    key: string,
    values?: QuotaHistoryValueSource,
  ): Promise<void> {
    if (values === undefined || this.seeded.get(key) === at) return
    const prepared = values.valueFor(sourceID, windowName, at, { seed: true })
    // No plan for this read: leave it unseeded so a later read retries.
    if (prepared === undefined) return
    const pointAt = pointKey(sourceID, windowName, at)
    let checkpointed = false
    try {
      const raw = await this.storage.get(pointAt)
      const stored = asPoint(raw)
      const head = this.heads.get(key)
      let current = head?.currentValue
      if (isRecord(raw) && raw.apiValue === undefined && stored !== undefined &&
        stored.sourceID === sourceID && stored.windowName === windowName && stored.observedAt === at) {
        const enriched = {
          ...stored,
          instanceAnchorAt: stored.instanceAnchorAt ?? head?.instanceAnchorAt ?? at,
          apiValue: head?.currentValue ?? prepared.apiValue,
          ...(prepared.apiValueSnapshots?.length ? { apiValueSnapshots: prepared.apiValueSnapshots } : {}),
        }
        await this.storage.set(pointAt, enriched)
        current = enriched.apiValue
      } else if (stored?.sourceID === sourceID && stored.windowName === windowName && stored.observedAt === at) {
        current = stored.apiValue ?? current
      }
      if (head && head.lastObservedAt === at) {
        // A compacted legacy point may be gone: publish an honest seed outcome,
        // not a projection reconstructed from an empty post-restart token buffer.
        current ??= prepared.apiValue
        if (head.currentValue === undefined) {
          const next = { ...head, currentValue: current,
            ...(asProjection(current, at) ? { latestEstimate: current } : {}) }
          await this.storage.set(key, { version: 1, ...next })
          this.heads.set(key, next)
        }
        checkpointed = true
      }
    } catch {
      // Do not mark seeded: retry the checkpoint on a later same-clock read.
      // Status reads storage, so an unpersisted computed value cannot look durable.
    }
    prepared.commit()
    if (checkpointed) this.seeded.set(key, at)
  }

  /**
   * A head rebuilt from a surviving point. `prior` is the head it replaces: its
   * latest projection carries forward inside one cycle, never across a boundary.
   */
  private headFromPoint(point: QuotaHistoryPoint, prior?: Head): Head {
    const latestEstimate = asProjection(point.apiValue, point.observedAt) ??
      (point.cycleBoundary ? undefined : prior?.latestEstimate)
    return {
      sourceID: point.sourceID,
      windowName: point.windowName,
      lastObservedAt: point.observedAt,
      lastPercent: point.percent,
      lastResetsAt: point.resetsAt,
      lastResetEstimated: point.resetEstimated,
      instanceAnchorAt: point.instanceAnchorAt ?? (point.cycleBoundary ? point.observedAt : prior?.instanceAnchorAt ?? point.observedAt),
      ...(point.apiValue === undefined ? {} : { currentValue: point.apiValue }),
      ...(latestEstimate === undefined ? {} : { latestEstimate }),
    }
  }

  /**
   * Whether the previous head's closure was already stored. ANY value at that key
   * counts, whatever its content: a damaged row is never overwritten and never
   * wedges the series, it only means that window closed. A failed read aborts, so
   * a transient failure cannot be mistaken for "no closure". Only a valid row for
   * this head can declare the observation older than the one that closed it.
   */
  private async closure(head: Head, at: number): Promise<"none" | "pending" | "older"> {
    const raw = await this.storage.get(windowKey(head.sourceID, head.windowName, head.lastObservedAt))
    if (raw === undefined) return "none"
    const row = asWindow(raw)
    return row !== undefined && row.sourceID === head.sourceID && row.windowName === head.windowName &&
      row.lastObservedAt === head.lastObservedAt && at < row.nextObservedAt ? "older" : "pending"
  }

  /** The durable point behind `head`, or undefined when absent, malformed or (non-strict) unreadable. */
  private async previousPoint(head: Head, strict: boolean): Promise<QuotaHistoryPoint | undefined> {
    let raw: unknown
    try {
      raw = await this.storage.get(pointKey(head.sourceID, head.windowName, head.lastObservedAt))
    } catch (error) {
      if (strict) throw error
      return undefined
    }
    const point = asPoint(raw)
    return point !== undefined && point.sourceID === head.sourceID && point.windowName === head.windowName &&
      point.observedAt === head.lastObservedAt ? point : undefined
  }

  /** The head's latest valid projection, or the newer one its durable point carries. */
  private withProjection(head: Head, previous: QuotaHistoryPoint | undefined): Head {
    const projected = asProjection(previous?.apiValue, head.lastObservedAt)
    return projected === undefined ? head : { ...head, latestEstimate: projected }
  }

  /**
   * Freeze the previous durable observation before advancing its point/head.
   * An unreadable store aborts (the caller read the point strictly); a missing or
   * malformed previous point leaves its value absent, because a missing value is
   * not zero. The row is never rewritten once stored.
   *
   * ponytail: closed windows are never pruned. A series adds at most one small row
   * per observed boundary (including rolling declines). Add an explicit archival
   * retention policy if that growth becomes material.
   */
  private async settleWindow(
    head: Head,
    previous: QuotaHistoryPoint | undefined,
    point: QuotaHistoryPoint,
    deadlineCrossed: boolean,
  ): Promise<void> {
    const key = windowKey(head.sourceID, head.windowName, head.lastObservedAt)
    const apiValue = previous?.apiValue
    const finalEstimate = head.latestEstimate
    const row: QuotaHistoryWindow = {
      version: 1,
      sourceID: head.sourceID,
      windowName: head.windowName,
      lastObservedAt: head.lastObservedAt,
      nextObservedAt: point.observedAt,
      lastPercent: head.lastPercent,
      nextPercent: point.percent,
      resetsAt: head.lastResetsAt,
      resetEstimated: head.lastResetEstimated,
      nextResetsAt: point.resetsAt,
      deadlineCrossed,
      instanceAnchorAt: head.instanceAnchorAt,
      ...(apiValue === undefined ? {} : { apiValue }),
      ...(finalEstimate === undefined ? {} : { finalEstimate }),
      ...(finalEstimate === undefined ? { finalEstimateReason: apiValue?.reason ?? head.currentValue?.reason ?? "No estimate recorded" } : {}),
    }
    await this.storage.set(key, row)
  }

  /** Recover from the newest point already written for this series before `at`. */
  private async repairHead(
    sourceID: string,
    windowName: string,
    head: Head | undefined,
    at: number,
    key: string,
    values?: QuotaHistoryValueSource,
  ): Promise<Head | undefined> {
    const latest = await this.latestPointBetween(sourceID, windowName, head, at)
    if (latest === undefined) return head
    const { point, recovered } = latest
    if (point.apiValue !== undefined) values?.recover?.(sourceID as UsageSourceID, windowName, { ...point, apiValue: point.apiValue })
    this.heads.set(key, recovered)
    this.missing.delete(key)
    return recovered
  }

  private async latestPointBetween(
    sourceID: string,
    windowName: string,
    prior: Head | undefined,
    at: number,
  ): Promise<{ point: QuotaHistoryPoint; recovered: Head } | undefined> {
    const prefix = pointPrefix(sourceID, windowName)
    let after = prior === undefined ? undefined : prefix + pad(prior.lastObservedAt)
    let latest: { point: QuotaHistoryPoint; recovered: Head } | undefined
    while (true) {
      const page = await this.scanPage(prefix, after)
      let done = false
      for (const entry of page.entries) {
        const point = asPoint(entry.value)
        if (!point || entry.key !== pointKey(point.sourceID, point.windowName, point.observedAt)) continue
        if (point.sourceID !== sourceID || point.windowName !== windowName) continue
        if (point.observedAt >= at) { done = true; break }
        latest = { point, recovered: this.headFromPoint(point, latest?.recovered ?? prior) }
      }
      if (done || !page.next || page.next === after) return latest
      after = page.next
      await yieldToHost()
    }
  }

  private async existingPoint(sourceID: string, windowName: string, at: number): Promise<QuotaHistoryPoint | undefined> {
    const value = await this.storage.get(pointKey(sourceID, windowName, at))
    if (value === undefined) return undefined
    const point = asPoint(value)
    if (!point || point.sourceID !== sourceID || point.windowName !== windowName || point.observedAt !== at) {
      throw new Error("Quota history point identity mismatch")
    }
    return point
  }

  private async maybeCompactLocked(now: number): Promise<void> {
    if (this.lastCompactedAt !== undefined && now - this.lastCompactedAt < HOUR_MS) return
    // Only mark success: a failed fold is retried on the next record or read.
    await this.compactLocked(now)
    this.lastCompactedAt = now
  }

  private async compactLocked(now: number): Promise<void> {
    const cutoff = now - QUOTA_HISTORY_RETENTION_MS
    for (const { head } of await this.scanHeads()) {
      await this.foldSeries(head, cutoff, now)
    }
  }

  /**
   * Fold one series page by page. The cumulative row is written with a
   * committed-through cursor before that page's raw points are removed, so a
   * failed set or remove can only be retried: points at or below the cursor are
   * counted once and then deleted. Points at the exact cutoff stay raw, and a
   * normal 90-day catch-up never loads the whole backlog into memory.
   *
   * ponytail: folds are serialized per plugin instance and assume one writer per
   * storage domain, like the telemetry ledgers. If multiple host processes share
   * a store, upgrade the checkpoint to a transactional compare-and-set.
   */
  private async foldSeries(head: Head, cutoff: number, now: number): Promise<void> {
    const cumulative = await this.loadCumulative(head.sourceID, head.windowName)
    let committedThrough = cumulative?.committedThrough ?? 0
    const next = cumulative === null
      ? emptyCumulative(head.sourceID, head.windowName)
      : { version: 1 as const, ...cumulative }
    const prefix = pointPrefix(head.sourceID, head.windowName)
    let after: string | undefined
    while (true) {
      const page = await this.scanPage(prefix, after)
      const foldable: QuotaHistoryPoint[] = []
      const stale: QuotaHistoryPoint[] = []
      let done = false
      for (const entry of page.entries) {
        const point = asPoint(entry.value)
        if (!point || entry.key !== pointKey(point.sourceID, point.windowName, point.observedAt)) continue
        if (point.observedAt >= cutoff) { done = true; break }
        if (point.observedAt <= committedThrough) stale.push(point)
        else foldable.push(point)
      }
      if (foldable.length > 0) {
        let foldedThrough = committedThrough
        for (const point of foldable) {
          addToCumulative(next, point)
          if (point.observedAt > foldedThrough) foldedThrough = point.observedAt
        }
        next.committedThrough = foldedThrough
        next.updatedAt = now
        await this.storage.set(cumulativeKey(head.sourceID, head.windowName), next)
        committedThrough = foldedThrough
      }
      for (const point of [...foldable, ...stale]) {
        await this.storage.remove!(pointKey(point.sourceID, point.windowName, point.observedAt))
      }
      if (done || !page.next || page.next === after) return
      after = page.next
      await yieldToHost()
    }
  }

  private async scanHeads(): Promise<Array<{ key: string; head: Head }>> {
    const entries = await this.scanAll(SERIES_PREFIX)
    const heads: Array<{ key: string; head: Head }> = []
    for (const entry of entries) {
      const head = asHead(entry.value)
      if (!head || entry.key !== seriesKey(head.sourceID, head.windowName)) continue
      this.heads.set(entry.key, head)
      heads.push({ key: entry.key, head })
    }
    return heads
  }

  private async scanPage(prefix: string, after?: string) {
    return await this.storage.scan!({ prefix, ...(after === undefined ? {} : { after }), limit: PAGE_SIZE })
  }

  private async scanAll(prefix: string): Promise<Array<{ key: string; value: unknown }>> {
    const entries: Array<{ key: string; value: unknown }> = []
    let after: string | undefined
    while (true) {
      const page = await this.scanPage(prefix, after)
      entries.push(...page.entries)
      if (!page.next || page.next === after) return entries
      after = page.next
      await yieldToHost()
    }
  }
}

export function quotaHistoryQueryFromInput(input: unknown):
  | { ok: true; query: QuotaHistoryQuery }
  | { ok: false; path: string; message: string } {
  if (!isRecord(input)) return { ok: false, path: "request", message: "expected an object" }
  for (const key of Object.keys(input)) {
    if (!["kind", "sourceID", "windowName", "from", "to", "limit", "cursor", "catalogCursor"].includes(key)) {
      return { ok: false, path: key, message: "unknown field" }
    }
  }
  if (input.kind !== undefined && input.kind !== "points" && input.kind !== "windows") {
    return { ok: false, path: "kind", message: 'expected "points" or "windows"' }
  }
  if (input.kind === "windows" && (input.sourceID === undefined || input.windowName === undefined)) {
    return { ok: false, path: "kind", message: "windows require a sourceID and windowName" }
  }
  if ((input.sourceID === undefined) !== (input.windowName === undefined)) {
    return { ok: false, path: "sourceID", message: "sourceID and windowName are required together" }
  }
  if (input.sourceID === undefined && (input.from !== undefined || input.to !== undefined || input.cursor !== undefined)) {
    return { ok: false, path: "sourceID", message: "from, to and cursor require a sourceID and windowName" }
  }
  if (input.sourceID !== undefined && input.catalogCursor !== undefined) {
    return { ok: false, path: "catalogCursor", message: "catalogCursor applies only to a catalog query" }
  }
  for (const field of ["sourceID", "windowName"] as const) {
    if (input[field] !== undefined && !text(input[field])) {
      return { ok: false, path: field, message: `expected a non-empty string up to ${MAX_TEXT} characters` }
    }
  }
  for (const field of ["from", "to"] as const) {
    if (input[field] !== undefined && !whole(input[field])) {
      return { ok: false, path: field, message: "expected a non-negative safe integer timestamp" }
    }
  }
  if (typeof input.from === "number" && typeof input.to === "number" && input.from > input.to) {
    return { ok: false, path: "from", message: "from must not be after to" }
  }
  if (input.limit !== undefined && (!whole(input.limit) || input.limit < 1 || input.limit > QUOTA_HISTORY_MAX_PAGE)) {
    return { ok: false, path: "limit", message: `expected an integer from 1 to ${QUOTA_HISTORY_MAX_PAGE}` }
  }
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string" || !/^(?:0|[1-9]\d{0,15})$/.test(input.cursor) ||
      !Number.isSafeInteger(Number(input.cursor))) {
      return { ok: false, path: "cursor", message: "expected a canonical timestamp cursor returned by this query" }
    }
  }
  if (input.catalogCursor !== undefined) {
    if (!canonicalCatalogCursor(input.catalogCursor)) {
      return { ok: false, path: "catalogCursor", message: "expected a canonical catalog cursor returned by this query" }
    }
  }
  return {
    ok: true,
    query: {
      // "points" is the default, so only the non-default kind is carried.
      ...(input.kind === "windows" ? { kind: "windows" as const } : {}),
      ...(input.sourceID === undefined ? {} : { sourceID: input.sourceID as string, windowName: input.windowName as string }),
      ...(input.from === undefined ? {} : { from: input.from as number }),
      ...(input.to === undefined ? {} : { to: input.to as number }),
      ...(input.limit === undefined ? {} : { limit: input.limit as number }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor as string }),
      ...(input.catalogCursor === undefined ? {} : { catalogCursor: input.catalogCursor as string }),
    },
  }
}

function canonicalCatalogCursor(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CATALOG_CURSOR) return false
  try {
    const decoded = JSON.parse(decodeURIComponent(value)) as unknown
    if (!Array.isArray(decoded) || decoded.length !== 2 || !text(decoded[0]) || !text(decoded[1])) return false
    return encodeSeries(decoded[0], decoded[1]) === value
  } catch {
    return false
  }
}
