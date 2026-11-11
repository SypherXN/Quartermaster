import assert from "node:assert/strict"
import test from "node:test"
import { parseConfig } from "../src/config.ts"
import {
  MIN_VALUE_SPAN_MS,
  QuotaValueTracker,
  VALUE_REASON_BASIS,
  VALUE_REASON_CACHE,
  VALUE_REASON_GAP,
  VALUE_REASON_LIMIT,
  VALUE_REASON_NO_PRICES,
  VALUE_REASON_NON_USD,
  VALUE_REASON_STALE,
  VALUE_REASON_TOKENS,
  type QuotaApiValue,
} from "../src/quota-values.ts"
import {
  pricesFromModels, quotaPricesFromModels, readPriceTable, readQuotaPriceTable, resetPriceCache, selectPrice,
  snapshotFromModels, type CatalogModelLike, type PriceTable,
} from "../src/telemetry/prices.ts"
import { frozenApiCost } from "../src/telemetry/costs.ts"
import type { TokenTelemetryRecord } from "../src/telemetry/types.ts"
import type { ModelsDevPrices } from "../src/telemetry/models-dev.ts"
import type { UsageReadResult, UsageSnapshot, UsageSource, UsageSourceID, UsageWindow } from "../src/usage.ts"

const MIN = 60_000
const t0 = Date.now()

function usage(at: number, percent: number, options: {
  resetsAt?: number | null
  state?: UsageWindow["state"]
  windows?: UsageWindow[]
  stale?: boolean
  authenticated?: boolean
  error?: string | null
  sourceID?: UsageSourceID
} = {}): UsageReadResult {
  const windows = options.windows ?? [{
    name: "weekly", usedPercent: percent, state: options.state ?? "ok", resetsAt: options.resetsAt ?? null,
  }]
  const source: UsageSource = {
    authenticated: options.authenticated ?? true, checkedAt: at, stale: options.stale ?? false,
    error: options.error ?? null, windows,
    nextAvailableAt: null, availability: "available",
  }
  const empty: UsageSource = {
    authenticated: true, checkedAt: at, stale: false, error: null, windows: [],
    nextAvailableAt: null, availability: "available",
  }
  const sources: UsageSnapshot["sources"] = { go: empty, codex: empty, cursor: empty }
  sources[options.sourceID ?? "codex"] = source
  return { status: "ok", snapshot: { updatedAt: at, sources } }
}

function tokenRecord(
  id: string,
  at: number,
  input: number,
  output: number,
  options: Partial<TokenTelemetryRecord> & { cacheRead?: number; cacheWrite?: number } = {},
): TokenTelemetryRecord {
  return {
    hostContractVersion: "2.0.18",
    hostEventID: id,
    sourceEvent: "session.step.ended",
    hostSessionID: "s",
    hostMessageID: "m",
    hostProjectID: "p",
    parentSessionID: null,
    hostAgentID: null,
    providerID: "openai",
    modelID: "m",
    variant: null,
    completedAt: at,
    counts: { input, output, reasoning: 0, cacheRead: options.cacheRead ?? 0, cacheWrite: options.cacheWrite ?? 0 },
    usageStatus: "reported",
    partial: false,
    hostCostUSD: 999,
    ...options,
  }
}

function rateConfig(currency = "USD") {
  return parseConfig({
    usageSources: { openai: "codex" },
    tokenRates: [{
      providerID: "openai", modelID: "m", inputPerMillion: 10, outputPerMillion: 20,
      currency, source: "test", asOf: 1,
    }],
  })
}

const catalogRow = (input: number, output: number, cacheRead = 0.5, cacheWrite = 1, tierSize?: number) => ({
  input,
  output,
  cache: { read: cacheRead, write: cacheWrite },
  ...(tierSize === undefined ? {} : { tier: { type: "context", size: tierSize } }),
})
const catalogModel = (
  providerID: string,
  modelID: string,
  name: string,
  cost?: ReturnType<typeof catalogRow>[],
): CatalogModelLike => ({ providerID, modelID, name, ...(cost === undefined ? {} : { cost }) })

function quotaCatalog(): CatalogModelLike[] {
  return [
    catalogModel("openai", "gpt-6-luna", "GPT-6 Luna"),
    catalogModel("openai", "gpt-6.1-sol", "GPT-6.1 Sol"),
    catalogModel("openai", "gpt-6-astra", "GPT-6 Astra"),
    catalogModel("opencode", "gpt-6-luna", "GPT-6 Luna", [catalogRow(10, 20)]),
    catalogModel("opencode", "gpt-6.1-sol", "GPT-6.1 Sol", [catalogRow(12, 24, 0.6, 1.2, 200_000)]),
    catalogModel("opencode", "gpt-6-astra", "GPT-6 Astra", [catalogRow(8, 16)]),
    catalogModel("claude-agent", "opus", "Opus 5.5"),
    catalogModel("claude-agent", "sonnet", "Sonnet 5.5"),
    catalogModel("claude-agent", "haiku", "Haiku 5.5"),
    catalogModel("opencode", "claude-opus-5-5", "Claude Opus 5.5", [catalogRow(3, 4, 0.3, 0.5)]),
    catalogModel("opencode", "claude-sonnet-5-5", "Claude Sonnet 5.5", [catalogRow(1, 2, 0.1, 0.2)]),
    catalogModel("opencode", "claude-haiku-5-5", "Claude Haiku 5.5", [catalogRow(0.5, 1, 0.05, 0.1)]),
  ]
}

const QUOTA_ALIASES = [
  ["openai/gpt-6-luna", "opencode/gpt-6-luna"],
  ["openai/gpt-6.1-sol", "opencode/gpt-6.1-sol"],
  ["openai/gpt-6-astra", "opencode/gpt-6-astra"],
  ["claude-agent/opus", "opencode/claude-opus-5-5"],
  ["claude-agent/sonnet", "opencode/claude-sonnet-5-5"],
  ["claude-agent/haiku", "opencode/claude-haiku-5-5"],
] as const

// Catalog route IDs differ from the upstream model IDs ordinary cost reports see.
function routeCatalog(): CatalogModelLike[] {
  return [
    { providerID: "openai", id: "gpt-6-luna", modelID: "gpt-6-luna-upstream", name: "GPT-6 Luna" },
    { providerID: "openai", id: "gpt-6.1-sol", modelID: "gpt-6.1-sol-upstream", name: "GPT-6.1 Sol" },
    { providerID: "openai", id: "gpt-6-astra", modelID: "gpt-6-astra-upstream", name: "GPT-6 Astra" },
    {
      providerID: "opencode", id: "gpt-6-luna", modelID: "gpt-6-luna-upstream", name: "GPT-6 Luna",
      cost: [catalogRow(10, 20, 2, 4), catalogRow(12, 24, 3, 6, 200_000)],
    },
    {
      providerID: "opencode", id: "gpt-6.1-sol", modelID: "gpt-6.1-sol-upstream", name: "GPT-6.1 Sol",
      cost: [catalogRow(12, 24, 0.6, 1.2, 200_000)],
    },
    { providerID: "opencode", id: "gpt-6-astra", modelID: "gpt-6-astra-upstream", name: "GPT-6 Astra", cost: [catalogRow(8, 16)] },
    { providerID: "claude-agent", id: "opus", modelID: "claude-opus-5-5", name: "Opus 5.5" },
    { providerID: "claude-agent", id: "sonnet", modelID: "claude-sonnet-5-5", name: "Sonnet 5.5" },
    { providerID: "claude-agent", id: "haiku", modelID: "claude-haiku-5-5", name: "Haiku 5.5" },
    {
      providerID: "opencode", id: "claude-opus-5-5", modelID: "claude-opus-upstream-5-5",
      name: "Claude Opus 5.5", cost: [catalogRow(3, 4, 0.3, 0.5)],
    },
    {
      providerID: "opencode", id: "claude-sonnet-5-5", modelID: "claude-sonnet-upstream-5-5",
      name: "Claude Sonnet 5.5", cost: [catalogRow(1, 2, 0.1, 0.2)],
    },
    {
      providerID: "opencode", id: "claude-haiku-5-5", modelID: "claude-haiku-upstream-5-5",
      name: "Claude Haiku 5.5", cost: [catalogRow(0.5, 1, 0.05, 0.1)],
    },
  ]
}

async function anchored(config = rateConfig(), prices: PriceTable = new Map()) {
  const tracker = new QuotaValueTracker(config)
  const plan = await tracker.prepare(usage(t0, 20), t0, prices)
  plan?.valueFor("codex", "weekly", t0)?.commit()
  return { tracker, prices, config }
}

function valueAt(tracker: QuotaValueTracker, at: number, percent: number, prices: PriceTable = new Map(), options: Parameters<typeof usage>[2] = {}): Promise<QuotaApiValue | undefined> {
  const sourceID = options.sourceID ?? "codex"
  return tracker.prepare(usage(at, percent, options), at, prices).then((plan) => {
    const prepared = plan?.valueFor(sourceID, "weekly", at)
    prepared?.commit()
    return prepared?.apiValue
  })
}

async function advance(
  tracker: QuotaValueTracker,
  prices: PriceTable,
  at: number,
  percent: number,
  options: Parameters<typeof usage>[2] = {},
): Promise<QuotaApiValue | undefined> {
  return valueAt(tracker, at, percent, prices, options)
}

test("prices observed work and projects from the quota delta, not the absolute percentage", async () => {
  const { tracker, prices } = await anchored()
  tracker.addTokenRecord(tokenRecord("e1", t0 + 5 * MIN, 1_000_000, 500_000))
  await advance(tracker, prices, t0 + 10 * MIN, 25)

  const value = await valueAt(tracker, t0 + 20 * MIN, 30, prices)
  assert.equal(value?.observedUSD, 20)
  assert.equal(value?.projectedFullUSD, 200)
  assert.equal(value?.projectionStatus, "estimated")
  assert.equal(value?.quotaDeltaPercent, 10)
  assert.equal(value?.spanMs, 20 * MIN)
  assert.equal(value?.trackingSince, t0)
  assert.equal(value?.records, 1)
  assert.equal(value?.pricedRecords, 1)
  assert.equal(value?.complete, false)

  // Same spend with a smaller delta projects a larger full allowance.
  const smaller = await anchored()
  smaller.tracker.addTokenRecord(tokenRecord("e2", t0 + 5 * MIN, 1_000_000, 500_000))
  await advance(smaller.tracker, smaller.prices, t0 + 10 * MIN, 22)
  const halfDelta = await valueAt(smaller.tracker, t0 + 20 * MIN, 25, smaller.prices)
  assert.equal(halfDelta?.projectedFullUSD, 400)
})

test("catalog pricing uses positive rows only, respects long-context tiers, and keeps zero rows unpriced", async () => {
  const config = parseConfig({ usageSources: { openai: "codex" } })
  const prices: PriceTable = new Map([["openai/m", [
    { tierSize: null, input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1, cacheReadKnown: true },
    { tierSize: 2_000, input: 10, output: 20, cacheRead: 5, cacheWrite: 10, cacheReadKnown: true },
  ]]])
  const tracker = new QuotaValueTracker(config)
  await tracker.prepare(usage(t0, 20), t0, prices).then((plan) => plan?.valueFor("codex", "weekly", t0)?.commit())
  // 3,000 input+cache-read selects the 2,000-token tier.
  tracker.addTokenRecord(tokenRecord("e1", t0 + 5 * MIN, 2_500, 500, { cacheRead: 500 }))
  await advance(tracker, prices, t0 + 10 * MIN, 25)
  const long = await valueAt(tracker, t0 + 20 * MIN, 30, prices)
  assert.ok((long?.observedUSD ?? 0) > 0)
  const expected = (2_500 * 10 + 500 * 20 + 500 * 5) / 1_000_000
  assert.ok(Math.abs((long?.observedUSD ?? 0) - expected) < 1e-12)

  const zero = new Map([["openai/m", [
    { tierSize: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheReadKnown: true },
  ]]]) as PriceTable
  const zeroTracker = new QuotaValueTracker(config)
  await zeroTracker.prepare(usage(t0, 20), t0, zero).then((plan) => plan?.valueFor("codex", "weekly", t0)?.commit())
  zeroTracker.addTokenRecord(tokenRecord("e2", t0 + 5 * MIN, 1_000, 1_000))
  await advance(zeroTracker, zero, t0 + 10 * MIN, 25)
  const unpriced = await valueAt(zeroTracker, t0 + 20 * MIN, 30, zero)
  assert.equal(unpriced?.observedUSD, null)
  assert.equal(unpriced?.pricedRecords, 0)
  assert.equal(unpriced?.unpricedRecords, 1)
  assert.equal(unpriced?.projectionStatus, "unavailable")
  assert.equal(unpriced?.reason, VALUE_REASON_NO_PRICES)

  const missing = new QuotaValueTracker(config)
  await missing.prepare(usage(t0, 20), t0, new Map()).then((plan) => plan?.valueFor("codex", "weekly", t0)?.commit())
  missing.addTokenRecord(tokenRecord("e3", t0 + 5 * MIN, 1_000, 1_000))
  await advance(missing, new Map(), t0 + 10 * MIN, 25)
  const noRow = await valueAt(missing, t0 + 20 * MIN, 30)
  assert.equal(noRow?.observedUSD, null)
  assert.equal(noRow?.reason, VALUE_REASON_NO_PRICES)
})

test("keeps a known subtotal but suppresses projection on cache, partial, missing and non-USD pricing", async () => {
  const cache = await anchored()
  cache.tracker.addTokenRecord(tokenRecord("e1", t0 + 5 * MIN, 1_000_000, 0, { cacheRead: 10_000 }))
  await advance(cache.tracker, cache.prices, t0 + 10 * MIN, 25)
  const cacheValue = await valueAt(cache.tracker, t0 + 20 * MIN, 30, cache.prices)
  assert.equal(cacheValue?.observedUSD, 10)
  assert.equal(cacheValue?.projectionStatus, "unavailable")
  assert.equal(cacheValue?.reason, VALUE_REASON_CACHE)

  const config = parseConfig({ usageSources: { openai: "codex" } })
  const unknownCache: PriceTable = new Map([["openai/m", [
    { tierSize: null, input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1, cacheReadKnown: false },
  ]]])
  const catalog = new QuotaValueTracker(config)
  await catalog.prepare(usage(t0, 20), t0, unknownCache).then((plan) => plan?.valueFor("codex", "weekly", t0)?.commit())
  catalog.addTokenRecord(tokenRecord("e2", t0 + 5 * MIN, 1_000_000, 0, { cacheRead: 10_000 }))
  await advance(catalog, unknownCache, t0 + 10 * MIN, 25)
  const cacheGap = await valueAt(catalog, t0 + 20 * MIN, 30, unknownCache)
  assert.equal(cacheGap?.observedUSD, 1.005)
  assert.equal(cacheGap?.reason, VALUE_REASON_CACHE)

  const partial = await anchored()
  partial.tracker.addTokenRecord(tokenRecord("e3", t0 + 5 * MIN, 1_000_000, 0, { partial: true }))
  await advance(partial.tracker, partial.prices, t0 + 10 * MIN, 25)
  const partialValue = await valueAt(partial.tracker, t0 + 20 * MIN, 30, partial.prices)
  assert.equal(partialValue?.observedUSD, 10)
  assert.equal(partialValue?.partialRecords, 1)
  assert.equal(partialValue?.reason, VALUE_REASON_TOKENS)

  const absent = await anchored()
  absent.tracker.addTokenRecord(tokenRecord("e4", t0 + 5 * MIN, 1_000, 0, {
    counts: null, usageStatus: "missing",
  } as never))
  await advance(absent.tracker, absent.prices, t0 + 10 * MIN, 25)
  const missingValue = await valueAt(absent.tracker, t0 + 20 * MIN, 30, absent.prices)
  assert.equal(missingValue?.observedUSD, null)
  assert.equal(missingValue?.unpricedRecords, 1)
  assert.equal(missingValue?.reason, VALUE_REASON_TOKENS)

  const foreign = await anchored(rateConfig("EUR"))
  foreign.tracker.addTokenRecord(tokenRecord("e5", t0 + 5 * MIN, 1_000_000, 0))
  await advance(foreign.tracker, foreign.prices, t0 + 10 * MIN, 25)
  const foreignValue = await valueAt(foreign.tracker, t0 + 20 * MIN, 30, foreign.prices)
  assert.equal(foreignValue?.observedUSD, null)
  assert.equal(foreignValue?.reason, VALUE_REASON_NON_USD)
})

test("values each window independently across mapped providers and never sums nested windows", async () => {
  const config = parseConfig({
    usageSources: { openai: "codex", other: "codex" },
    quotaExemptModels: ["other/exempt"],
    tokenRates: [
      { providerID: "openai", modelID: "m", inputPerMillion: 10, outputPerMillion: 20, currency: "USD", source: "test", asOf: 1 },
      { providerID: "other", modelID: "x", inputPerMillion: 5, outputPerMillion: 5, currency: "USD", source: "test", asOf: 1 },
    ],
  })
  const tracker = new QuotaValueTracker(config)
  const windows = [
    { name: "weekly", usedPercent: 30, state: "ok" as const, resetsAt: null },
    { name: "daily", usedPercent: 25, state: "ok" as const, resetsAt: null },
  ]
  await tracker.prepare(usage(t0, 20, { windows: windows.map((window) => ({ ...window, usedPercent: 20 })) }), t0, new Map())
    .then((plan) => { for (const name of ["weekly", "daily"]) plan?.valueFor("codex", name, t0)?.commit() })
  tracker.addTokenRecord(tokenRecord("e1", t0 + 5 * MIN, 1_000_000, 0))
  tracker.addTokenRecord(tokenRecord("e2", t0 + 6 * MIN, 1_000_000, 0, { providerID: "other", modelID: "x" }))
  tracker.addTokenRecord(tokenRecord("e3", t0 + 7 * MIN, 5_000_000, 0, { providerID: "other", modelID: "exempt" }))
  const mid = [
    { name: "weekly", usedPercent: 25, state: "ok" as const, resetsAt: null },
    { name: "daily", usedPercent: 22, state: "ok" as const, resetsAt: null },
  ]
  await tracker.prepare(usage(t0 + 10 * MIN, 0, { windows: mid }), t0 + 10 * MIN, new Map())
    .then((plan) => { for (const name of ["weekly", "daily"]) plan?.valueFor("codex", name, t0 + 10 * MIN)?.commit() })
  const plan = await tracker.prepare(usage(t0 + 20 * MIN, 30, { windows }), t0 + 20 * MIN, new Map())
  const weekly = plan?.valueFor("codex", "weekly", t0 + 20 * MIN)
  const daily = plan?.valueFor("codex", "daily", t0 + 20 * MIN)
  weekly?.commit()
  daily?.commit()
  assert.equal(weekly?.apiValue.observedUSD, 15)
  assert.equal(daily?.apiValue.observedUSD, 15)
  assert.equal(weekly?.apiValue.records, 2)
  assert.equal(weekly?.apiValue.projectedFullUSD, 150)
  assert.equal(daily?.apiValue.projectedFullUSD, 300)
})

test("a reset snapshots the previous observation value and excludes the uncertain boundary interval", async () => {
  const { tracker, prices } = await anchored()
  tracker.addTokenRecord(tokenRecord("e1", t0 + 5 * MIN, 1_000_000, 500_000))
  await advance(tracker, prices, t0 + 10 * MIN, 25)
  const before = await tracker.prepare(usage(t0 + 20 * MIN, 30), t0 + 20 * MIN, prices)
  const previous = before?.valueFor("codex", "weekly", t0 + 20 * MIN)
  previous?.commit()
  assert.equal(previous?.apiValue.observedUSD, 20)

  // Work in the uncertain gap is attributable to neither segment.
  tracker.addTokenRecord(tokenRecord("e2", t0 + 25 * MIN, 5_000_000, 0))
  const resetPlan = await tracker.prepare(usage(t0 + 30 * MIN, 2), t0 + 30 * MIN, prices)
  const reset = resetPlan?.valueFor("codex", "weekly", t0 + 30 * MIN)
  reset?.commit()
  assert.equal(reset?.apiValueSnapshots.length, 1)
  assert.equal(reset?.apiValueSnapshots[0].event, "reset")
  assert.equal(reset?.apiValueSnapshots[0].value.observedUSD, 20)
  assert.equal(reset?.apiValueSnapshots[0].value.projectedFullUSD, 200)
  assert.equal(reset?.apiValue.trackingSince, t0 + 30 * MIN)
  assert.equal(reset?.apiValue.observedUSD, null)

  tracker.addTokenRecord(tokenRecord("e3", t0 + 40 * MIN, 700_000, 0))
  const next = await valueAt(tracker, t0 + 45 * MIN, 5, prices)
  assert.equal(next?.observedUSD, 7)
  assert.equal(next?.trackingSince, t0 + 30 * MIN)
})

test("saves a max transition once, handles first-seen max, and keeps reset+max segment IDs distinct", async () => {
  const { tracker, prices } = await anchored()
  tracker.addTokenRecord(tokenRecord("e1", t0 + 5 * MIN, 1_000_000, 0))
  await advance(tracker, prices, t0 + 10 * MIN, 60)
  const maxPlan = await tracker.prepare(usage(t0 + 20 * MIN, 100), t0 + 20 * MIN, prices)
  const maxed = maxPlan?.valueFor("codex", "weekly", t0 + 20 * MIN)
  maxed?.commit()
  assert.equal(maxed?.apiValueSnapshots.filter((snapshot) => snapshot.event === "maxed").length, 1)
  assert.equal(maxed?.apiValueSnapshots[0].value.observedUSD, 10)
  const again = await tracker.prepare(usage(t0 + 25 * MIN, 100), t0 + 25 * MIN, prices)
  assert.equal(again?.valueFor("codex", "weekly", t0 + 25 * MIN)?.apiValueSnapshots.length, 0)
  again?.valueFor("codex", "weekly", t0 + 25 * MIN)?.commit()

  const firstMax = new QuotaValueTracker(rateConfig())
  const firstPlan = await firstMax.prepare(usage(t0, 100), t0, new Map())
  const first = firstPlan?.valueFor("codex", "weekly", t0)
  first?.commit()
  assert.equal(first?.apiValueSnapshots.length, 1)
  assert.equal(first?.apiValueSnapshots[0].event, "maxed")
  assert.equal(first?.apiValueSnapshots[0].value.observedUSD, null)
  assert.equal(first?.apiValue.reason !== null, true)

  const resetMax = await anchored()
  resetMax.tracker.addTokenRecord(tokenRecord("e2", t0 + 5 * MIN, 1_000_000, 0))
  await advance(resetMax.tracker, resetMax.prices, t0 + 10 * MIN, 25, { resetsAt: t0 + 25 * MIN })
  const prior = await resetMax.tracker.prepare(usage(t0 + 20 * MIN, 30, { resetsAt: t0 + 25 * MIN }), t0 + 20 * MIN, resetMax.prices)
  prior?.valueFor("codex", "weekly", t0 + 20 * MIN)?.commit()
  const both = await resetMax.tracker.prepare(usage(t0 + 30 * MIN, 100, { resetsAt: null }), t0 + 30 * MIN, resetMax.prices)
  const bothValue = both?.valueFor("codex", "weekly", t0 + 30 * MIN)
  bothValue?.commit()
  assert.deepEqual(bothValue?.apiValueSnapshots.map((snapshot) => snapshot.event), ["reset", "maxed"])
  assert.notEqual(bothValue?.apiValueSnapshots[0].segmentID, bothValue?.apiValueSnapshots[1].segmentID)
})

test("a new tracker anchors on the first fresh quota and ignores persisted history", async () => {
  const first = await anchored()
  first.tracker.addTokenRecord(tokenRecord("e1", t0 + 5 * MIN, 1_000_000, 0))
  await valueAt(first.tracker, t0 + 20 * MIN, 30, first.prices)

  const restarted = new QuotaValueTracker(first.config)
  restarted.addTokenRecord(tokenRecord("e2", t0 + 25 * MIN, 1_000_000, 0))
  const plan = await restarted.prepare(usage(t0 + 30 * MIN, 35), t0 + 30 * MIN, first.prices)
  const value = plan?.valueFor("codex", "weekly", t0 + 30 * MIN)
  value?.commit()
  assert.equal(value?.apiValue.trackingSince, t0 + 30 * MIN)
  assert.equal(value?.apiValue.observedUSD, null)
  assert.equal(value?.apiValueSnapshots.length, 0)
})

test("mapping, pricing and record-limit changes reanchor with an explicit warning", async () => {
  const mapping = await anchored()
  mapping.tracker.addTokenRecord(tokenRecord("e1", t0 + 5 * MIN, 1_000_000, 0))
  await advance(mapping.tracker, mapping.prices, t0 + 10 * MIN, 25)
  const prior = await mapping.tracker.prepare(usage(t0 + 20 * MIN, 30), t0 + 20 * MIN, mapping.prices)
  prior?.valueFor("codex", "weekly", t0 + 20 * MIN)?.commit()
  mapping.config.usageSources.extra = "codex"
  const changed = await mapping.tracker.prepare(usage(t0 + 30 * MIN, 32), t0 + 30 * MIN, mapping.prices)
  const changedValue = changed?.valueFor("codex", "weekly", t0 + 30 * MIN)
  changedValue?.commit()
  assert.equal(changedValue?.apiValueSnapshots.length, 0)
  assert.equal(changedValue?.apiValue.reason, VALUE_REASON_BASIS)
  assert.equal(changedValue?.apiValue.trackingSince, t0 + 30 * MIN)

  const repriced = await anchored()
  await advance(repriced.tracker, repriced.prices, t0 + 10 * MIN, 25)
  const repricedPlan = await repriced.tracker.prepare(usage(t0 + 20 * MIN, 30), t0 + 20 * MIN, new Map([["openai/m", [
    { tierSize: null, input: 2, output: 2, cacheRead: 0, cacheWrite: 0, cacheReadKnown: true, cacheWriteKnown: true },
  ]]]))
  const repricedValue = repricedPlan?.valueFor("codex", "weekly", t0 + 20 * MIN)
  repricedValue?.commit()
  assert.equal(repricedValue?.apiValueSnapshots.length, 0)
  assert.equal(repricedValue?.apiValue.reason, VALUE_REASON_BASIS)

  const saturated = await anchored()
  await advance(saturated.tracker, saturated.prices, t0 + 10 * MIN, 21)
  for (let index = 0; index <= 10_000; index++) {
    saturated.tracker.addTokenRecord(tokenRecord(`limit-${index}`, t0 + MIN, 1_000, 0))
  }
  const overflow = await saturated.tracker.prepare(usage(t0 + 20 * MIN, 22), t0 + 20 * MIN, new Map())
  const overflowValue = overflow?.valueFor("codex", "weekly", t0 + 20 * MIN)
  overflowValue?.commit()
  assert.equal(overflowValue?.apiValue.reason, VALUE_REASON_LIMIT)
  assert.equal(overflowValue?.apiValue.trackingSince, t0 + 20 * MIN)
})

test("saves a real reset after a gap or stale read from the frozen previous value and allocates no gap work", async () => {
  const gap = await anchored()
  gap.tracker.addTokenRecord(tokenRecord("e1", t0 + 5 * MIN, 1_000_000, 0))
  await advance(gap.tracker, gap.prices, t0 + 10 * MIN, 25)
  // Work inside the uncertain boundary interval must not be priced anywhere.
  gap.tracker.addTokenRecord(tokenRecord("gap-work", t0 + 20 * MIN, 5_000_000, 0))
  const gapPlan = await gap.tracker.prepare(usage(t0 + 30 * MIN, 2), t0 + 30 * MIN, gap.prices)
  const afterGap = gapPlan?.valueFor("codex", "weekly", t0 + 30 * MIN)
  afterGap?.commit()
  assert.equal(afterGap?.apiValue.reason, VALUE_REASON_GAP)
  assert.equal(afterGap?.apiValue.trackingSince, t0 + 30 * MIN)
  assert.equal(afterGap?.apiValue.observedUSD, null)
  assert.equal(afterGap?.apiValueSnapshots.length, 1)
  assert.equal(afterGap?.apiValueSnapshots[0].event, "reset")
  assert.equal(afterGap?.apiValueSnapshots[0].value.observedAt, t0 + 10 * MIN)
  assert.equal(afterGap?.apiValueSnapshots[0].value.observedUSD, 10)

  const stale = await anchored()
  stale.tracker.addTokenRecord(tokenRecord("e2", t0 + 5 * MIN, 1_000_000, 0))
  await advance(stale.tracker, stale.prices, t0 + 10 * MIN, 25)
  await stale.tracker.prepare(usage(t0 + 15 * MIN, 25, { stale: true }), t0 + 15 * MIN, stale.prices)
  const stalePlan = await stale.tracker.prepare(usage(t0 + 16 * MIN, 2), t0 + 16 * MIN, stale.prices)
  const staleValue = stalePlan?.valueFor("codex", "weekly", t0 + 16 * MIN)
  staleValue?.commit()
  assert.equal(staleValue?.apiValue.reason, VALUE_REASON_STALE)
  assert.equal(staleValue?.apiValue.trackingSince, t0 + 16 * MIN)
  assert.equal(staleValue?.apiValue.observedUSD, null)
  assert.equal(staleValue?.apiValueSnapshots.length, 1)
  assert.equal(staleValue?.apiValueSnapshots[0].event, "reset")
  assert.equal(staleValue?.apiValueSnapshots[0].value.observedAt, t0 + 10 * MIN)
  assert.equal(staleValue?.apiValueSnapshots[0].value.observedUSD, 10)
})

test("removes deleted or excluded records from valuation", async () => {
  const config = parseConfig({ usageSources: { openai: "codex" }, quotaExemptModels: ["openai/m", "openai/exempt"] })
  const tracker = new QuotaValueTracker(config)
  await tracker.prepare(usage(t0, 20), t0, new Map()).then((plan) => plan?.valueFor("codex", "weekly", t0)?.commit())
  const record = tokenRecord("e1", t0 + 5 * MIN, 1_000_000, 0)
  tracker.addTokenRecord(record)
  tracker.addTokenRecord(tokenRecord("e2", t0 + 6 * MIN, 1_000_000, 0, { modelID: "exempt" }))
  await advance(tracker, new Map(), t0 + 10 * MIN, 25)
  const excluded = await valueAt(tracker, t0 + 20 * MIN, 30)
  assert.equal(excluded?.records, 0)

  const open = new QuotaValueTracker(rateConfig())
  await open.prepare(usage(t0, 20), t0, new Map()).then((plan) => plan?.valueFor("codex", "weekly", t0)?.commit())
  open.addTokenRecord(record)
  open.removeTokenRecords([record])
  await advance(open, new Map(), t0 + 10 * MIN, 25)
  const removed = await valueAt(open, t0 + 20 * MIN, 30)
  assert.equal(removed?.records, 0)
  assert.equal(removed?.observedUSD, null)
})

test("recovery resyncs an in-process anchor and does not replay a reset snapshot", async () => {
  const { tracker, prices } = await anchored()
  tracker.addTokenRecord(tokenRecord("e1", t0 + 5 * MIN, 1_000_000, 0))
  await advance(tracker, prices, t0 + 10 * MIN, 25)
  const prior = await tracker.prepare(usage(t0 + 20 * MIN, 30, { resetsAt: t0 + 25 * MIN }), t0 + 20 * MIN, prices)
  prior?.valueFor("codex", "weekly", t0 + 20 * MIN)?.commit()

  prior?.recover("codex", "weekly", {
    percent: 2,
    observedAt: t0 + 30 * MIN,
    resetsAt: null,
    state: "ok",
    apiValue: {
      currency: "USD", basis: "api-equivalent-not-billed", observedUSD: 10,
      projectedFullUSD: null, projectionStatus: "unavailable", reason: "Need 15 minutes of fresh observations",
      trackingSince: t0 + 30 * MIN, observedAt: t0 + 30 * MIN, spanMs: 0, quotaDeltaPercent: 0,
      records: 1, pricedRecords: 1, unpricedRecords: 0, partialRecords: 0, complete: false,
    },
  })
  tracker.addTokenRecord(tokenRecord("e2", t0 + 40 * MIN, 700_000, 0))
  const plan = await tracker.prepare(usage(t0 + 45 * MIN, 5), t0 + 45 * MIN, prices)
  const value = plan?.valueFor("codex", "weekly", t0 + 45 * MIN)
  value?.commit()
  assert.equal(value?.apiValueSnapshots.length, 0)
  assert.equal(value?.apiValue.trackingSince, t0 + 30 * MIN)
  assert.equal(value?.apiValue.observedUSD, 7)
})

test("flags unknown catalog cache-write pricing instead of pricing it as free", async () => {
  const config = parseConfig({ usageSources: { openai: "codex" } })
  const missingWrite = pricesFromModels([{
    providerID: "openai", modelID: "m", cost: [{ input: 1, output: 2, cache: { read: 0.5 } }],
  }])
  const tracker = new QuotaValueTracker(config)
  await tracker.prepare(usage(t0, 20), t0, missingWrite).then((plan) => plan?.valueFor("codex", "weekly", t0)?.commit())
  tracker.addTokenRecord(tokenRecord("e1", t0 + 5 * MIN, 1_000_000, 0, { cacheWrite: 1_000 }))
  await advance(tracker, missingWrite, t0 + 8 * MIN, 24)
  const unknownWrite = await valueAt(tracker, t0 + 16 * MIN, 30, missingWrite)
  assert.equal(unknownWrite?.observedUSD, 1)
  assert.equal(unknownWrite?.reason, VALUE_REASON_CACHE)

  const explicitZero = pricesFromModels([{
    providerID: "openai", modelID: "m", cost: [{ input: 1, output: 2, cache: { read: 0.5, write: 0 } }],
  }])
  const known = new QuotaValueTracker(config)
  await known.prepare(usage(t0, 20), t0, explicitZero).then((plan) => plan?.valueFor("codex", "weekly", t0)?.commit())
  known.addTokenRecord(tokenRecord("e1", t0 + 5 * MIN, 1_000_000, 0, { cacheWrite: 1_000 }))
  await advance(known, explicitZero, t0 + 8 * MIN, 24)
  const knownWrite = await valueAt(known, t0 + 16 * MIN, 30, explicitZero)
  assert.equal(knownWrite?.observedUSD, 1)
  assert.equal(knownWrite?.reason, null)
  assert.equal(knownWrite?.projectionStatus, "estimated")
})

test("invalidates a span on a long observation gap or a missing/stale source, but not on a cached clock", async () => {
  const gap = await anchored()
  gap.tracker.addTokenRecord(tokenRecord("e1", t0 + 5 * MIN, 1_000_000, 0))
  const gapValue = await valueAt(gap.tracker, t0 + 16 * MIN, 30, gap.prices)
  assert.equal(gapValue?.reason, VALUE_REASON_GAP)
  assert.equal(gapValue?.trackingSince, t0 + 16 * MIN)
  assert.equal(gapValue?.observedUSD, null)

  const stale = await anchored()
  stale.tracker.addTokenRecord(tokenRecord("e2", t0 + 5 * MIN, 1_000_000, 0))
  const stalePlan = await stale.tracker.prepare(usage(t0 + 10 * MIN, 25, { stale: true }), t0 + 10 * MIN, stale.prices)
  assert.equal(stalePlan?.valueFor("codex", "weekly", t0 + 10 * MIN), undefined)
  const staleValue = await valueAt(stale.tracker, t0 + 11 * MIN, 25, stale.prices)
  assert.equal(staleValue?.reason, VALUE_REASON_STALE)
  assert.equal(staleValue?.trackingSince, t0 + 11 * MIN)

  const missing = await anchored()
  missing.tracker.addTokenRecord(tokenRecord("e3", t0 + 5 * MIN, 1_000_000, 0))
  await missing.tracker.prepare(usage(t0 + 10 * MIN, 0, { windows: [] }), t0 + 10 * MIN, missing.prices)
  const missingValue = await valueAt(missing.tracker, t0 + 11 * MIN, 25, missing.prices)
  assert.equal(missingValue?.reason, VALUE_REASON_STALE)
  assert.equal(missingValue?.trackingSince, t0 + 11 * MIN)

  const cached = await anchored()
  cached.tracker.addTokenRecord(tokenRecord("e4", t0 + 5 * MIN, 1_000_000, 0))
  await cached.tracker.prepare(usage(t0, 20), t0, cached.prices)
  const cachedValue = await valueAt(cached.tracker, t0 + 10 * MIN, 25, cached.prices)
  assert.equal(cachedValue?.trackingSince, t0)
  assert.notEqual(cachedValue?.reason, VALUE_REASON_GAP)
  assert.notEqual(cachedValue?.reason, VALUE_REASON_STALE)
})

test("keeps overflow invalidation per series until each window reanchors", async () => {
  const config = parseConfig({ usageSources: { openai: "codex" } })
  const tracker = new QuotaValueTracker(config)
  const windows20 = [
    { name: "weekly", usedPercent: 20, state: "ok" as const, resetsAt: null },
    { name: "daily", usedPercent: 20, state: "ok" as const, resetsAt: null },
  ]
  const windows25 = windows20.map((window) => ({ ...window, usedPercent: 25 }))
  for (const window of windows20) {
    await tracker.prepare(usage(t0, 20, { windows: windows20 }), t0, new Map())
      .then((plan) => plan?.valueFor("codex", window.name, t0)?.commit())
  }
  for (const window of windows25) {
    await tracker.prepare(usage(t0 + 10 * MIN, 25, { windows: windows25 }), t0 + 10 * MIN, new Map())
      .then((plan) => plan?.valueFor("codex", window.name, t0 + 10 * MIN)?.commit())
  }
  for (let index = 0; index <= 10_000; index++) {
    tracker.addTokenRecord(tokenRecord(`limit-${index}`, t0 + MIN, 1_000, 0))
  }
  const flagged = await tracker.prepare(usage(t0 + 20 * MIN, 30, { windows: windows20.map((window) => ({ ...window, usedPercent: 30 })) }), t0 + 20 * MIN, new Map())
  flagged?.valueFor("codex", "weekly", t0 + 20 * MIN)?.commit()

  const nextWindows = windows20.map((window) => ({ ...window, usedPercent: 31 }))
  const next = await tracker.prepare(usage(t0 + 30 * MIN, 31, { windows: nextWindows }), t0 + 30 * MIN, new Map())
  const weekly = next?.valueFor("codex", "weekly", t0 + 30 * MIN)
  const daily = next?.valueFor("codex", "daily", t0 + 30 * MIN)
  weekly?.commit()
  daily?.commit()
  assert.equal(weekly?.apiValue.trackingSince, t0 + 20 * MIN)
  assert.equal(daily?.apiValue.trackingSince, t0 + 30 * MIN)
  assert.equal(daily?.apiValue.reason, VALUE_REASON_LIMIT)
})

test("derives quota prices for the six verified equivalents without changing report prices", async () => {
  const models = quotaCatalog()
  const direct = pricesFromModels(models)
  const quota = quotaPricesFromModels(models)
  for (const [sourceKey, targetKey] of QUOTA_ALIASES) {
    assert.equal(direct.has(sourceKey), false, sourceKey)
    assert.deepEqual(quota.get(sourceKey), direct.get(targetKey), sourceKey)
  }
  // Ordinary cost reporting keeps its subscription/unpriced semantics.
  assert.equal(direct.has("openai/gpt-6-luna"), false)
  assert.equal(quota.has("opencode/gpt-6-luna"), true)
  const snapshot = snapshotFromModels(models)
  assert.equal(snapshot.prices.has("openai/gpt-6-luna"), false)
  assert.equal(snapshot.quotaPrices.has("openai/gpt-6-luna"), true)
  // Cache metadata and context tiers survive the copy.
  assert.deepEqual(quota.get("opencode/gpt-6.1-sol")?.[0], direct.get("opencode/gpt-6.1-sol")?.[0])
  assert.equal(quota.get("opencode/gpt-6.1-sol")?.[0].tierSize, 200_000)
  assert.equal(quota.get("opencode/gpt-6.1-sol")?.[0].cacheWriteKnown, true)
})

test("the shared catalog cache exposes separate report and quota tables", async () => {
  resetPriceCache()
  try {
    const list = async () => ({ data: quotaCatalog() })
    const report = await readPriceTable(list)
    const quota = await readQuotaPriceTable(list)
    assert.equal(report.has("openai/gpt-6-luna"), false)
    assert.equal(quota.has("openai/gpt-6-luna"), true)
    assert.equal(report.has("opencode/gpt-6-luna"), true)
  } finally {
    resetPriceCache()
  }
})

test("uses catalog route ids for quota aliases while ordinary reports keep upstream ids", () => {
  const models = routeCatalog()
  const quota = quotaPricesFromModels(models)
  assert.equal(quota.get("claude-agent/opus")?.[0].input, 3)
  assert.equal(quota.get("openai/gpt-6-luna")?.[0].input, 10)
  assert.equal(quota.has("claude-agent/claude-opus-5-5"), false)
  assert.equal(quota.has("openai/gpt-6-luna-upstream"), false)

  const report = pricesFromModels(models)
  assert.equal(report.has("opencode/claude-opus-upstream-5-5"), true)
  assert.equal(report.has("opencode/claude-opus-5-5"), false)
  assert.equal(report.has("opencode/gpt-6-luna-upstream"), true)
  assert.equal(report.has("opencode/gpt-6-luna"), false)

  // An upstream-only match must not borrow prices: the route id is the alias.
  const sourceDrift = routeCatalog().map((model) =>
    model.providerID === "claude-agent" && model.id === "opus" ? { ...model, id: "opus-6" } : model)
  assert.equal(quotaPricesFromModels(sourceDrift).has("claude-agent/opus-6"), false)
  const targetDrift = routeCatalog().map((model) =>
    model.providerID === "opencode" && model.id === "claude-opus-5-5" ? { ...model, id: "claude-opus-next" } : model)
  assert.equal(quotaPricesFromModels(targetDrift).has("claude-agent/opus"), false)
})

test("prices every token component and selects short/long context tiers from the derived table", async () => {
  const models = routeCatalog()
  const quota = quotaPricesFromModels(models)
  const config = parseConfig({ usageSources: { openai: "codex" } })
  const valueFor = async (input: number, output: number, cacheRead: number, cacheWrite: number) => {
    const tracker = new QuotaValueTracker(config)
    await tracker.prepare(usage(t0, 20), t0, quota)
      .then((plan) => plan?.valueFor("codex", "weekly", t0)?.commit())
    tracker.addTokenRecord(tokenRecord("event", t0 + 5 * MIN, input, output, {
      providerID: "openai", modelID: "gpt-6-luna", cacheRead, cacheWrite,
    }))
    await advance(tracker, quota, t0 + 8 * MIN, 24)
    return valueAt(tracker, t0 + 16 * MIN, 30, quota)
  }
  const short = await valueFor(100_000, 50_000, 10_000, 5_000)
  assert.ok(Math.abs((short?.observedUSD ?? 0) - 2.04) < 1e-12)
  const long = await valueFor(250_000, 50_000, 10_000, 5_000)
  assert.ok(Math.abs((long?.observedUSD ?? 0) - 4.26) < 1e-12)
})

test("requires the source alias and target metadata before borrowing prices", async () => {
  const models = quotaCatalog()
  const noSource = quotaPricesFromModels(models.filter((model) => !(model.providerID === "openai" && model.modelID === "gpt-6-luna")))
  assert.equal(noSource.has("openai/gpt-6-luna"), false)

  const wrongAlias = quotaPricesFromModels(models.map((model) =>
    model.providerID === "claude-agent" && model.modelID === "opus" ? { ...model, name: "Opus 5.6" } : model))
  assert.equal(wrongAlias.has("claude-agent/opus"), false)

  const wrongTargetName = quotaPricesFromModels(models.map((model) =>
    model.providerID === "opencode" && model.modelID === "claude-sonnet-5-5" ? { ...model, name: "Sonnet 5.5" } : model))
  assert.equal(wrongTargetName.has("claude-agent/sonnet"), false)

  const noTarget = quotaPricesFromModels(models.filter((model) => !(model.providerID === "opencode" && model.modelID === "claude-haiku-5-5")))
  assert.equal(noTarget.has("claude-agent/haiku"), false)

  const zeroTarget = quotaPricesFromModels(models.map((model) =>
    model.providerID === "opencode" && model.modelID === "gpt-6-astra" ? { ...model, cost: [catalogRow(0, 0, 0, 0)] } : model))
  assert.equal(zeroTarget.has("openai/gpt-6-astra"), false)

  // No fuzzy matches for fast/free/Go variants or other alias generations.
  const extras = [...models,
    catalogModel("openai", "gpt-6-luna-fast", "GPT-6 Luna Fast"),
    catalogModel("claude-agent", "opus-fast", "Opus 5.5 Fast"),
    catalogModel("opencode-go", "gpt-6-luna", "GPT-6 Luna"),
    catalogModel("openai-compatible", "gpt-6-luna", "GPT-6 Luna"),
  ]
  const extraQuota = quotaPricesFromModels(extras)
  assert.equal(extraQuota.has("openai/gpt-6-luna-fast"), false)
  assert.equal(extraQuota.has("claude-agent/opus-fast"), false)
  assert.equal(extraQuota.has("opencode-go/gpt-6-luna"), false)
  assert.equal(extraQuota.has("openai-compatible/gpt-6-luna"), false)
})

test("a direct positive source price wins and a zero source row falls back", async () => {
  const models = quotaCatalog()
  const directWins = models.map((model) =>
    model.providerID === "openai" && model.modelID === "gpt-6-luna" ? { ...model, cost: [catalogRow(9, 18)] } : model)
  const quota = quotaPricesFromModels(directWins)
  assert.equal(quota.get("openai/gpt-6-luna")?.[0].input, 9)

  const zeroSource = models.map((model) =>
    model.providerID === "openai" && model.modelID === "gpt-6.1-sol" ? { ...model, cost: [catalogRow(0, 0, 0, 0)] } : model)
  const fallback = quotaPricesFromModels(zeroSource)
  assert.equal(fallback.get("openai/gpt-6.1-sol")?.[0].input, 12)
})

test("values all six subscription aliases through the derived quota table", async () => {
  const models = quotaCatalog()
  const quota = quotaPricesFromModels(models)
  const mappings = [
    { sourceProvider: "openai", sourceID: "codex", sourceModel: "gpt-6-luna", rate: 10 },
    { sourceProvider: "openai", sourceID: "codex", sourceModel: "gpt-6.1-sol", rate: 12 },
    { sourceProvider: "openai", sourceID: "codex", sourceModel: "gpt-6-astra", rate: 8 },
    { sourceProvider: "claude-agent", sourceID: "claude-agent", sourceModel: "opus", rate: 3 },
    { sourceProvider: "claude-agent", sourceID: "claude-agent", sourceModel: "sonnet", rate: 1 },
    { sourceProvider: "claude-agent", sourceID: "claude-agent", sourceModel: "haiku", rate: 0.5 },
  ] as const
  for (const mapping of mappings) {
    const config = parseConfig({ usageSources: { [mapping.sourceProvider]: mapping.sourceID } })
    const tracker = new QuotaValueTracker(config)
    await tracker.prepare(usage(t0, 20, { sourceID: mapping.sourceID }), t0, quota)
      .then((plan) => plan?.valueFor(mapping.sourceID, "weekly", t0)?.commit())
    tracker.addTokenRecord(tokenRecord(`event-${mapping.sourceModel}`, t0 + 5 * MIN, 1_000_000, 0, {
      providerID: mapping.sourceProvider, modelID: mapping.sourceModel, variant: "thinking",
    }))
    await advance(tracker, quota, t0 + 8 * MIN, 24, { sourceID: mapping.sourceID })
    const value = await valueAt(tracker, t0 + 16 * MIN, 30, quota, { sourceID: mapping.sourceID })
    assert.equal(value?.observedUSD, mapping.rate, mapping.sourceModel)
    assert.equal(value?.projectionStatus, "estimated", mapping.sourceModel)
  }
})

test("a target price change reanchors quota tracking without a synthetic reset", async () => {
  const models = quotaCatalog()
  const before = quotaPricesFromModels(models)
  const after = quotaPricesFromModels(models.map((model) =>
    model.providerID === "opencode" && model.modelID === "gpt-6-luna" ? { ...model, cost: [catalogRow(20, 40)] } : model))
  const config = parseConfig({ usageSources: { openai: "codex" } })
  const tracker = new QuotaValueTracker(config)
  await tracker.prepare(usage(t0, 20), t0, before).then((plan) => plan?.valueFor("codex", "weekly", t0)?.commit())
  await advance(tracker, before, t0 + 8 * MIN, 24)
  const changed = await tracker.prepare(usage(t0 + 16 * MIN, 30), t0 + 16 * MIN, after)
  const value = changed?.valueFor("codex", "weekly", t0 + 16 * MIN)
  value?.commit()
  assert.equal(value?.apiValue.reason, VALUE_REASON_BASIS)
  assert.equal(value?.apiValueSnapshots.length, 0)
  assert.equal(value?.apiValue.trackingSince, t0 + 16 * MIN)
})

test("a models.dev price change reanchors without a synthetic reset", async () => {
  const models: CatalogModelLike[] = [
    { providerID: "openai", id: "gpt-6-luna", modelID: "upstream-luna", name: "GPT-6 Luna" },
  ]
  const row = (input: number) => ({
    tierSize: null, input, output: 20, cacheRead: 1, cacheReadKnown: true, cacheWrite: 2, cacheWriteKnown: true,
  })
  const api = (input: number): ModelsDevPrices => ({
    openai: new Map([["gpt-6-luna", [row(input)]]]),
    anthropicByName: new Map(),
  })
  const before = quotaPricesFromModels(models, api(10))
  const after = quotaPricesFromModels(models, api(20))
  const config = parseConfig({ usageSources: { openai: "codex" } })
  const tracker = new QuotaValueTracker(config)
  await tracker.prepare(usage(t0, 20), t0, before)
    .then((plan) => plan?.valueFor("codex", "weekly", t0)?.commit())
  await advance(tracker, before, t0 + 8 * MIN, 24)
  const changed = await tracker.prepare(usage(t0 + 16 * MIN, 30), t0 + 16 * MIN, after)
  const value = changed?.valueFor("codex", "weekly", t0 + 16 * MIN)
  value?.commit()
  assert.equal(value?.apiValue.reason, VALUE_REASON_BASIS)
  assert.equal(value?.apiValueSnapshots.length, 0)
  assert.equal(value?.apiValue.trackingSince, t0 + 16 * MIN)
})

test("prices opencode jev-1.13 from the opencode host catalog and freezes that snapshot", () => {
  // The host route id is `jev-1.13`; the upstream model id is only what ordinary
  // cost reporting keys on, so the quota table must normalize the route id.
  const models: CatalogModelLike[] = [{
    providerID: "opencode", id: "jev-1.13", modelID: "jev-1.13-upstream", name: "Jev 1.13",
    limit: { context: 400_000 },
    cost: [catalogRow(2, 8, 0.2, 0.5), catalogRow(4, 16, 0.4, 1, 200_000)],
  }]
  // An unrelated API-vendor price must not replace the opencode host price.
  const decoy: ModelsDevPrices = {
    openai: new Map([["jev-1.13", [catalogRow(999, 999)]]]),
    anthropicByName: new Map(),
  }
  const quota = quotaPricesFromModels(models, decoy)
  const rows = quota.get("opencode/jev-1.13")
  assert.equal(rows?.length, 2)
  assert.equal(quota.has("opencode/jev-1.13-upstream"), false)
  assert.equal(pricesFromModels(models).has("opencode/jev-1.13-upstream"), true)

  // Host input/output/cache and both context tiers survive.
  assert.deepEqual(rows?.[0], {
    tierSize: null, input: 2, output: 8, cacheRead: 0.2, cacheReadKnown: true, cacheWrite: 0.5, cacheWriteKnown: true,
  })
  assert.equal(selectPrice(rows, 150_000)?.input, 2)
  assert.equal(selectPrice(rows, 250_000)?.input, 4)
  assert.equal(selectPrice(rows, 250_000)?.cacheWrite, 1)

  // The first durable write freezes those host prices; a later catalog change
  // does not reprice the stored record.
  const record = tokenRecord("jev", t0, 100_000, 100_000, {
    providerID: "opencode", modelID: "jev-1.13", cacheRead: 50_000, cacheWrite: 50_000,
    apiPrice: { recordedAt: t0, source: "catalog", prices: rows!.map((row) => ({ ...row })) },
  })
  const frozen = frozenApiCost(record)
  assert.equal(frozen?.pricedRecords, 1)
  assert.ok(Math.abs((frozen?.cacheRead ?? 0) - 0.01) < 1e-12)
  assert.ok(Math.abs((frozen?.cacheWrite ?? 0) - 0.025) < 1e-12)
  assert.ok(Math.abs((frozen?.total ?? 0) - 1.035) < 1e-12)

  const repriced = quotaPricesFromModels(models.map((model) => ({ ...model, cost: [catalogRow(40, 80)] })))
  assert.equal(repriced.get("opencode/jev-1.13")?.[0].input, 40)
  assert.equal(frozenApiCost(record)?.total, frozen?.total)
})
