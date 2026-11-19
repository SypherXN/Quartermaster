type Histogram = Record<number, number>

export interface PerformanceHistogram {
  version: 1
  outputTokensPerSecond?: Histogram
  observedTtftMs?: Histogram
}

export interface StepPerformance {
  providerID: string
  modelID: string
  variant: string | null
  histogram: PerformanceHistogram
}

export interface ModelPerformance {
  medianOutputTokensPerSecond: number | null
  outputTokensPerSecondSamples: number
  medianObservedTtftMs: number | null
  p95ObservedTtftMs: number | null
  observedTtftSamples: number
}

// ponytail: eight buckets per doubling, exact below 16, bounded to 177
// possible bins. Report the lower edge; reserve zero for measured zeros.
const MAX = 2 ** 24
const bucket = (n: number) => {
  const width = Math.max(1, 2 ** (Math.floor(Math.log2(n)) - 3))
  return Math.floor(n / width) * width
}
const metrics = ["outputTokensPerSecond", "observedTtftMs"] as const

export function performanceSample(outputTokensPerSecond: number | undefined, ttftMs: number | undefined): PerformanceHistogram | undefined {
  if (outputTokensPerSecond !== undefined && (!Number.isFinite(outputTokensPerSecond) || outputTokensPerSecond < 0)) {
    outputTokensPerSecond = undefined
  }
  const rate = outputTokensPerSecond === undefined || outputTokensPerSecond === 0
    ? outputTokensPerSecond : Math.max(1, Math.round(outputTokensPerSecond * 100))
  return asPerformanceHistogram({
    version: 1,
    ...(rate === undefined || rate > MAX ? {} : { outputTokensPerSecond: { [bucket(rate)]: 1 } }),
    ...(ttftMs === undefined || !Number.isSafeInteger(ttftMs) || ttftMs < 0 || ttftMs > MAX
      ? {} : { observedTtftMs: { [bucket(ttftMs)]: 1 } }),
  }, 1)
}

function asHistogram(value: unknown, maxSamples: number): Histogram | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > 177) return undefined
  const bins: Histogram = {}
  let sum = 0
  for (const [key, count] of entries) {
    const n = Number(key)
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX || String(n) !== key || bucket(n) !== n ||
      typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0 || count > maxSamples - sum) return undefined
    sum += count
    bins[n] = count
  }
  return bins
}

export function asPerformanceHistogram(value: unknown, maxSamples = Number.MAX_SAFE_INTEGER): PerformanceHistogram | undefined {
  if (typeof value !== "object" || value === null || (value as { version?: unknown }).version !== 1) return undefined
  const source = value as Record<string, unknown>
  const hist: PerformanceHistogram = { version: 1 }
  for (const metric of metrics) {
    const bins = asHistogram(source[metric], maxSamples)
    if (bins) hist[metric] = bins
  }
  return metrics.some((metric) => hist[metric]) ? hist : undefined
}

export function addPerformance(target: PerformanceHistogram, source: PerformanceHistogram): void {
  for (const metric of metrics) {
    if (!source[metric]) continue
    const bins = target[metric] ??= {}
    for (const [key, count] of Object.entries(source[metric])) {
      const n = Number(key)
      bins[n] = Math.min(Number.MAX_SAFE_INTEGER, (bins[n] ?? 0) + count)
    }
  }
}

function sampleCount(bins: Histogram | undefined): number {
  return Object.values(bins ?? {}).reduce((sum, count) => Math.min(Number.MAX_SAFE_INTEGER, sum + count), 0)
}

function percentile(bins: Histogram | undefined, rank: number): number | null {
  // Integer object keys are enumerated in ascending order.
  for (const [key, count] of Object.entries(bins ?? {})) {
    rank -= count
    if (rank <= 0) return Number(key)
  }
  return null
}

export function summarizePerformance(hist?: PerformanceHistogram): ModelPerformance {
  const rate = hist?.outputTokensPerSecond
  const ttft = hist?.observedTtftMs
  const outputTokensPerSecondSamples = sampleCount(rate)
  const observedTtftSamples = sampleCount(ttft)
  const medianRate = percentile(rate, Math.ceil(outputTokensPerSecondSamples / 2))
  return {
    medianOutputTokensPerSecond: medianRate === null ? null : medianRate / 100,
    outputTokensPerSecondSamples,
    medianObservedTtftMs: percentile(ttft, Math.ceil(observedTtftSamples / 2)),
    p95ObservedTtftMs: percentile(ttft, Math.ceil(observedTtftSamples * 0.95)),
    observedTtftSamples,
  }
}
