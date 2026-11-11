import { QUOTA_BLOCK_PERCENT } from "./eligibility.ts"
import type { UsageReadResult, UsageSource, UsageSourceID, UsageWindow } from "./usage.ts"

export const QUOTA_ESTIMATE_STORAGE_KEY = "routing/quota-estimates-v1"
export const QUOTA_ESTIMATE_HISTORY_MS = 60 * 60_000
export const QUOTA_OBSERVATION_FRESH_MS = 5 * 60_000
const MAX_OBSERVATION_GAP_MS = 15 * 60_000
const MIN_SPAN_MS = 15 * 60_000
const MAX_SAMPLES = 120
const MAX_SERIES = 32

export type QuotaEstimateStatus =
  | "estimated"
  | "insufficient-history"
  | "no-recent-usage"
  | "stale"
  | "cutoff-reached"

export interface QuotaEstimate {
  status: QuotaEstimateStatus
  cutoffPercent: number
  sampleCount: number
  spanMs: number
  ratePerMinute?: number
  cutoffAt?: number
}

interface Sample {
  at: number
  percent: number
}

interface Series {
  resetsAt: number | null
  resetEstimated: boolean
  samples: Sample[]
}

interface StoredHistory {
  version: 1
  series: Record<string, Series>
}

type Storage = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const keyFor = (sourceID: string, name: string) => `${sourceID}::${name}`

/**
 * The observation clock is authoritative even when an upstream snapshot cached a
 * stale=false source: a missing, future or older-than-five-minute timestamp is not
 * fresh enough to extend the trend.
 */
export function freshObservationAt(source: UsageSource, now: number): number | undefined {
  if (!source.authenticated || source.error !== null || source.stale) return undefined
  const at = source.checkedAt
  if (typeof at !== "number" || !Number.isFinite(at) || at > now || now - at > QUOTA_OBSERVATION_FRESH_MS) return undefined
  return at
}

const staleEstimate = (): QuotaEstimate => ({
  status: "stale",
  cutoffPercent: QUOTA_BLOCK_PERCENT,
  sampleCount: 0,
  spanMs: 0,
})

/**
 * A bounded percentage history for configured quota windows, persisted with the
 * plugin's storage. It only turns observed percentages into a trend; it never
 * derives a percentage from token counts and never feeds eligibility.
 */
export class QuotaEstimates {
  private series = new Map<string, Series>()

  static async load(storage: Storage, now = Date.now()): Promise<QuotaEstimates> {
    const result = new QuotaEstimates()
    try {
      result.restore(await storage.get(QUOTA_ESTIMATE_STORAGE_KEY), now)
    } catch {
      // A missing or unreadable history only costs the first forecast.
    }
    return result
  }

  /** Record fresh observations. Returns true when the persisted shape changed. */
  observe(usage: UsageReadResult | undefined, now = Date.now()): boolean {
    if (usage?.status !== "ok") return false
    let changed = false
    const seen = new Set<string>()
    for (const [rawSourceID, source] of Object.entries(usage.snapshot.sources)) {
      if (!source) continue
      const sourceID = rawSourceID as UsageSourceID
      if (!source.authenticated || source.error !== null) {
        changed = this.dropSource(sourceID) || changed
        continue
      }
      const at = freshObservationAt(source, now)
      for (const window of source.windows) {
        const key = keyFor(sourceID, window.name)
        seen.add(key)
        if (
          at === undefined ||
          typeof window.usedPercent !== "number" ||
          !Number.isFinite(window.usedPercent) ||
          window.usedPercent < 0 ||
          window.usedPercent > 100
        ) continue
        changed = this.record(key, at, window, now) || changed
      }
    }
    for (const key of [...this.series.keys()]) {
      if (!seen.has(key)) {
        this.series.delete(key)
        changed = true
      }
    }
    const before = this.seriesSignature()
    this.prune(now)
    return changed || before !== this.seriesSignature()
  }

  /** Status-facing estimate for one visible window. */
  estimate(sourceID: UsageSourceID, window: UsageWindow, now = Date.now()): QuotaEstimate | undefined {
    const percent = window.usedPercent
    if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined
    this.prune(now)
    const record = this.series.get(keyFor(sourceID, window.name))
    const samples = record?.samples ?? []
    const spanMs = samples.length > 1 ? samples[samples.length - 1].at - samples[0].at : 0
    const base = { cutoffPercent: QUOTA_BLOCK_PERCENT, sampleCount: samples.length, spanMs }
    // A reset that has already happened ends the recorded cycle: the old
    // percentage cannot predict the new one.
    if (typeof window.resetsAt === "number" && window.resetsAt <= now) {
      return { status: "insufficient-history", ...base }
    }
    if (percent >= QUOTA_BLOCK_PERCENT) return { status: "cutoff-reached", ...base }
    if (!record || samples.length < 2) return { status: "insufficient-history", ...base }
    if (record.resetsAt !== (window.resetsAt ?? null) || record.resetEstimated !== (window.resetEstimated === true)) {
      return { status: "insufficient-history", cutoffPercent: QUOTA_BLOCK_PERCENT, sampleCount: 0, spanMs: 0 }
    }
    const first = samples[0]
    const latest = samples[samples.length - 1]
    if (now - latest.at > QUOTA_OBSERVATION_FRESH_MS) return { status: "stale", ...base }
    if (spanMs < MIN_SPAN_MS) return { status: "insufficient-history", ...base }
    const ratePerMinute = (latest.percent - first.percent) / (spanMs / 60_000)
    if (!Number.isFinite(ratePerMinute) || ratePerMinute <= 0) return { status: "no-recent-usage", ...base }
    const cutoffAt = latest.at + ((QUOTA_BLOCK_PERCENT - latest.percent) / ratePerMinute) * 60_000
    if (!Number.isFinite(cutoffAt)) return { status: "insufficient-history", ...base }
    return { status: "estimated", ...base, ratePerMinute, cutoffAt }
  }

  stale(): QuotaEstimate {
    return staleEstimate()
  }

  snapshot(): StoredHistory {
    return {
      version: 1,
      series: Object.fromEntries([...this.series].map(([key, series]) => [key, {
        resetsAt: series.resetsAt,
        resetEstimated: series.resetEstimated,
        samples: series.samples.map((sample) => ({ at: sample.at, percent: sample.percent })),
      }])),
    }
  }

  async save(storage: Storage): Promise<void> {
    await storage.set(QUOTA_ESTIMATE_STORAGE_KEY, this.snapshot())
  }

  private restore(value: unknown, now: number): void {
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.series)) return
    for (const [key, raw] of Object.entries(value.series)) {
      if (this.series.size >= MAX_SERIES || typeof key !== "string" || !isRecord(raw)) break
      if (
        !(raw.resetsAt === null || (typeof raw.resetsAt === "number" && Number.isFinite(raw.resetsAt))) ||
        typeof raw.resetEstimated !== "boolean" ||
        !Array.isArray(raw.samples)
      ) continue
      const samples: Sample[] = []
      for (const sample of raw.samples) {
        if (
          !isRecord(sample) ||
          typeof sample.at !== "number" || !Number.isFinite(sample.at) || sample.at > now ||
          typeof sample.percent !== "number" || !Number.isFinite(sample.percent) ||
          sample.percent < 0 || sample.percent > 100 ||
          (samples.length > 0 && sample.at <= samples[samples.length - 1].at)
        ) break
        samples.push({ at: sample.at, percent: sample.percent })
        if (samples.length >= MAX_SAMPLES) break
      }
      if (samples.length) this.series.set(key, { resetsAt: raw.resetsAt, resetEstimated: raw.resetEstimated, samples })
    }
    this.prune(now)
  }

  private record(key: string, at: number, window: UsageWindow, now: number): boolean {
    const resetsAt = window.resetsAt ?? null
    const resetEstimated = window.resetEstimated === true
    const percent = window.usedPercent as number
    const previous = this.series.get(key)
    if (previous === undefined || previous.resetsAt !== resetsAt || previous.resetEstimated !== resetEstimated) {
      this.series.set(key, { resetsAt, resetEstimated, samples: [{ at, percent }] })
      return true
    }
    const latest = previous.samples[previous.samples.length - 1]
    if (!latest) {
      previous.samples = [{ at, percent }]
      return true
    }
    // A cached snapshot re-reports the same clock: it is one observation, not a rate.
    if (at === latest.at) return false
    // Out-of-order reads, a reset, a quota drop and a long poll gap all break the line.
    if (at < latest.at || percent < latest.percent || at - latest.at > MAX_OBSERVATION_GAP_MS) {
      previous.samples = [{ at, percent }]
      return true
    }
    previous.samples.push({ at, percent })
    if (previous.samples.length > MAX_SAMPLES) previous.samples.splice(0, previous.samples.length - MAX_SAMPLES)
    return true
  }

  private dropSource(sourceID: UsageSourceID): boolean {
    let changed = false
    const prefix = `${sourceID}::`
    for (const key of [...this.series.keys()]) {
      if (key.startsWith(prefix)) {
        this.series.delete(key)
        changed = true
      }
    }
    return changed
  }

  private prune(now: number): void {
    const cutoff = now - QUOTA_ESTIMATE_HISTORY_MS
    for (const [key, series] of this.series) {
      series.samples = series.samples.filter((sample) => sample.at >= cutoff && sample.at <= now)
      if (series.samples.length === 0) this.series.delete(key)
    }
    if (this.series.size <= MAX_SERIES) return
    const oldest = [...this.series.entries()].sort(([, left], [, right]) =>
      left.samples[left.samples.length - 1].at - right.samples[right.samples.length - 1].at)
    for (const [key] of oldest.slice(0, oldest.length - MAX_SERIES)) this.series.delete(key)
  }

  private seriesSignature(): string {
    return [...this.series].map(([key, series]) =>
      `${key}:${series.resetsAt}:${series.resetEstimated}:${series.samples.length}:${series.samples[series.samples.length - 1]?.at ?? 0}`).join("|")
  }
}
