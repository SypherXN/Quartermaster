import assert from "node:assert/strict"
import test from "node:test"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { buildQuartermasterReport } from "../src/telemetry/report.ts"
import { DirectUsageLedger, type DirectUsageInput } from "../src/telemetry/direct-usage.ts"
import type { CatalogPrice, PriceTable } from "../src/telemetry/prices.ts"
import type { TokenLifetime, TokenRollup } from "../src/telemetry/ledger.ts"
import type { TokenTelemetryRecord } from "../src/telemetry/types.ts"
import type { TokenRateConfig, TokenBudgetConfig } from "../src/config.ts"
import type { ProjectView, ReportQuery } from "../src/telemetry/report.ts"

const at = 1_000
const empty = new Map<string, CatalogPrice[]>() as PriceTable

function record(
  id: string,
  providerID: string | null,
  modelID: string | null,
  input: number,
  output: number,
  options: {
    at?: number
    cacheRead?: number
    cacheWrite?: number
    partial?: boolean
    missing?: boolean
    hostCostUSD?: number
    apiPrices?: CatalogPrice[]
  } = {},
): TokenTelemetryRecord {
  return {
    hostContractVersion: "2.0.18",
    hostEventID: id,
    sourceEvent: "session.step.ended",
    hostSessionID: `session-${id}`,
    hostMessageID: `message-${id}`,
    hostProjectID: "project-a",
    parentSessionID: null,
    hostAgentID: null,
    providerID,
    modelID,
    variant: null,
    completedAt: options.at ?? at,
    counts: options.missing ? null : {
      input, output, reasoning: 0,
      cacheRead: options.cacheRead ?? 0,
      cacheWrite: options.cacheWrite ?? 0,
    },
    usageStatus: options.missing ? "missing" : "reported",
    partial: options.partial ?? false,
    ...(options.hostCostUSD === undefined ? {} : { hostCostUSD: options.hostCostUSD }),
    ...(options.apiPrices === undefined ? {} : {
      apiPrice: { recordedAt: options.at ?? at, source: "catalog", prices: options.apiPrices },
    }),
  }
}

const price = (input: number, output: number, cacheRead = 0, cacheWrite = 0, tierSize: number | null = null): CatalogPrice => ({
  tierSize, input, output,
  cacheRead, cacheReadKnown: true, cacheWrite, cacheWriteKnown: true,
})

class MemoryStorage implements StorageDomain {
  values = new Map<string, unknown>()
  async get(key: string) { return this.values.get(key) as never }
  async set(key: string, value: unknown) { this.values.set(key, value) }
  async remove(key: string) { this.values.delete(key) }
  async scan(options: { prefix: string; after?: string; limit?: number }) {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(options.prefix) && (!options.after || key > options.after)).sort()
    const page = keys.slice(0, options.limit ?? 1_000)
    return {
      entries: page.map((key) => ({ key, value: this.values.get(key) as never })),
      ...(keys.length > page.length ? { next: page.at(-1)! } : {}),
    }
  }
}

function directInput(usageID: string, projectID = "project-a"): DirectUsageInput {
  return {
    projectID, pluginID: "opr", pluginName: "OPR", usageID,
    providerID: "openai", modelID: "gpt-6-luna",
    counts: { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

async function build(input: {
  records: TokenTelemetryRecord[]
  prices?: PriceTable
  rates?: readonly TokenRateConfig[]
  rollups?: TokenRollup[]
  lifetime?: TokenLifetime[]
  budgets?: readonly TokenBudgetConfig[]
  now?: () => number
  query?: ReportQuery
  view?: ProjectView
  direct?: { records: unknown[]; rollups: unknown[] }
  claims?: unknown[]
}) {
  return buildQuartermasterReport({
    projectID: "project-a",
    tokenLedger: {
      list: async () => input.records,
      listRollups: async () => input.rollups ?? [],
      listLifetime: async () => input.lifetime ?? [],
      ...(input.lifetime === undefined ? {} : {
        snapshot: async () => ({
          records: input.records,
          rollups: input.rollups ?? [],
          lifetime: input.lifetime ?? [],
        }),
      }),
    },
    errorLedger: { list: async () => [] },
    attributionLedger: { list: async () => input.claims ?? [] },
    budgets: input.budgets,
    now: input.now,
    tokenRates: input.rates,
    catalog: async () => ({
      prices: input.prices ?? empty,
      contextLimits: new Map(),
    }),
    ...(input.direct === undefined ? {} : {
      directUsageLedger: {
        list: async () => input.direct!.records,
        listRollups: async () => input.direct!.rollups,
        listLifetime: async () => [],
      } as never,
    }),
  }, input.query ?? { limit: 100, offset: 0 }, false, input.view)
}

test("subscription-routed OpenAI and Claude models get API-equivalent USD", async () => {
  const openaiPrice = [price(10, 20, 1, 2)]
  const claudePrice = [price(3, 4, 0.3, 0.5)]
  const records = [
    record("o1", "openai", "gpt-6-luna", 1_000_000, 500_000, {
      cacheRead: 100_000, cacheWrite: 50_000, apiPrices: openaiPrice,
    }),
    record("c1", "claude-agent", "opus", 100_000, 50_000, {
      cacheRead: 10_000, cacheWrite: 5_000, apiPrices: claudePrice,
    }),
  ]
  const report = await build({ records })
  const usd = report.apiEquivalent?.currencies.find((currency) => currency.currency === "USD")
  assert.ok(usd)
  assert.ok(Math.abs(usd.estimatedAmount - 20.7055) < 1e-9)
  assert.equal(report.apiEquivalent?.pricing, "recorded-api-price")
  assert.equal(report.apiEquivalent?.scope, "selected-range-with-older-cumulative")
  assert.ok(Math.abs((report.apiEquivalent?.retainedUSD ?? 0) - 20.7055) < 1e-9)
  assert.equal(report.apiEquivalent?.archivedUSD, null)
  // Ordinary costs still use the ordinary catalog, where these have no price.
  assert.equal(report.costs.currencies.length, 0)
  const model = report.dimensions.items.find((item) => item.value === "openai/gpt-6-luna")
  assert.equal(model?.apiCosts?.pricedRecords, 1)
  assert.ok(Math.abs((model?.apiCosts?.total ?? 0) - 20.2) < 1e-9)
  assert.equal(model?.costs?.pricedRecords, 0)
})

test("API-equivalent uses frozen catalog prices only, leaving config rates, host cost and budgets unchanged", async () => {
  const rates: TokenRateConfig[] = [{
    providerID: "openai", modelID: "gpt-6-luna", inputPerMillion: 1, outputPerMillion: 1,
    currency: "USD", source: "test", asOf: 1,
  }]
  const report = await build({
    records: [record("o1", "openai", "gpt-6-luna", 1_000_000, 500_000, {
      hostCostUSD: 99, apiPrices: [price(10, 20)],
    })],
    rates,
    budgets: [],
  })
  assert.equal(report.costs.currencies[0].estimatedAmount, 1.5)
  assert.equal(report.costs.hostReported.amount, 99)
  assert.equal(report.apiEquivalent?.currencies[0].estimatedAmount, 20)
  assert.deepEqual(report.budgets, [])
})

test("context tiers and all cache components select per record and sum consistently", async () => {
  const frozen = [
    price(1, 2, 0.5, 1),
    price(3, 4, 0.25, 0.5, 200_000),
  ]
  const records = [
    record("short", "openai", "gpt-6-luna", 100_000, 10_000, { cacheRead: 1_000, cacheWrite: 2_000, apiPrices: frozen }),
    record("long", "openai", "gpt-6-luna", 250_000, 10_000, { cacheRead: 1_000, cacheWrite: 2_000, apiPrices: frozen }),
  ]
  const report = await build({ records })
  const usd = report.apiEquivalent?.currencies.find((currency) => currency.currency === "USD")
  assert.ok(usd)
  assert.ok(Math.abs(usd.estimatedAmount - 0.91375) < 1e-12)
  const model = report.dimensions.items.find((item) => item.value === "openai/gpt-6-luna")
  assert.ok(model?.apiCosts)
  const components = (model?.apiCosts?.input ?? 0) + (model?.apiCosts?.output ?? 0) +
    (model?.apiCosts?.cacheRead ?? 0) + (model?.apiCosts?.cacheWrite ?? 0)
  assert.ok(Math.abs(components - (model?.apiCosts?.total ?? 0)) < 1e-12)
  assert.ok(Math.abs((model?.apiCosts?.total ?? 0) - 0.91375) < 1e-12)
})

test("unknown cache dimensions, partial records and missing models stay explicit and unpriced", async () => {
  const frozen = [{
    tierSize: null, input: 1, output: 1, cacheRead: 0, cacheReadKnown: false,
    cacheWrite: 0, cacheWriteKnown: false,
  }]
  const records = [
    record("unknown-cache", "openai", "m", 1_000, 1_000, { cacheRead: 1_000, cacheWrite: 1_000, apiPrices: frozen }),
    record("partial", "openai", "m", 1_000, 0, { partial: true, apiPrices: frozen }),
    record("missing-model", "unknown", "x", 1_000, 0, { apiPrices: [] }),
    record("missing-tokens", "openai", "m", 0, 0, { missing: true, apiPrices: frozen }),
    record("legacy", "openai", "m", 1_000, 0),
  ]
  const report = await build({ records })
  assert.equal(report.apiEquivalent?.cacheUnpricedRecords, 1)
  assert.equal(report.apiEquivalent?.partialRecords, 2)
  assert.equal(report.apiEquivalent?.pricedRecords, 2)
  assert.equal(report.apiEquivalent?.unpricedRecords, 3)
  assert.equal(report.apiEquivalent?.legacyUnknownRecords, 1)
  const model = report.dimensions.items.find((item) => item.value === "openai/m")
  assert.equal(model?.apiCosts?.cacheUnpricedRecords, 1)
  assert.equal(model?.apiCosts?.partialRecords, 2)
})

test("all-zero catalog rows never become a priced zero and model apiCosts stays null", async () => {
  const report = await build({
    records: [record("o1", "openai", "gpt-6-luna", 1_000, 0, { apiPrices: [price(0, 0, 0, 0)] })],
  })
  assert.deepEqual(report.apiEquivalent?.currencies, [])
  assert.equal(report.apiEquivalent?.pricedRecords, 0)
  assert.equal(report.apiEquivalent?.unpricedRecords, 1)
  assert.equal(report.dimensions.items.find((item) => item.value === "openai/gpt-6-luna")?.apiCosts, null)
})

test("range filters change the API-equivalent total and archived rollups stay out of scope", async () => {
  const frozen = [price(1, 0)]
  const rollup: TokenRollup = {
    projectID: "project-a", day: 1, records: 5, observedTokens: 5_000, unknownTokenRecords: 0, slices: [],
  }
  const records = [
    record("early", "openai", "gpt-6-luna", 1_000, 0, { at: 100, apiPrices: frozen }),
    record("late", "openai", "gpt-6-luna", 2_000, 0, { at: 900, apiPrices: frozen }),
  ]
  const ranged = await build({ records, query: { since: 500, until: 1_000, limit: 100, offset: 0 } })
  assert.equal(ranged.apiEquivalent?.pricedRecords, 1)
  assert.ok(Math.abs((ranged.apiEquivalent?.currencies[0].estimatedAmount ?? 0) - 0.002) < 1e-12)
  assert.equal(ranged.apiEquivalent?.scope, "retained-raw-records")
  assert.equal(ranged.apiEquivalent?.archivedUSD, null)
  assert.equal(ranged.apiEquivalent?.archivedRecords, 0)

  const all = await build({ records, rollups: [rollup] })
  assert.equal(all.apiEquivalent?.pricedRecords, 2)
  assert.ok(Math.abs((all.apiEquivalent?.currencies[0].estimatedAmount ?? 0) - 0.003) < 1e-12)
  assert.equal(all.apiEquivalent?.scope, "selected-range-with-older-cumulative")
  assert.equal(all.totals.records, 7)
  assert.equal(all.apiEquivalent?.archivedRecords, 5)
  assert.equal(all.apiEquivalent?.legacyUnknownRecords, 5)
  assert.equal(all.apiEquivalent?.unpricedRecords, 5)
})

const apiCost = (total: number, pricedRecords: number, pricedTokens: number) => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total,
  pricedRecords, unpricedRecords: 0, partialRecords: 0, cacheUnpricedRecords: 0,
  pricedTokens, unpricedTokens: 0, unknownTokenRecords: 0,
})

function lifetime(
  projectID: string,
  records: number,
  options: {
    agentID?: string | null
    apiRecords?: number
    apiUnknownRecords?: number
    apiCost?: ReturnType<typeof apiCost>
  } = {},
): TokenLifetime {
  return {
    projectID, hostSessionID: `session-${projectID}`, parentSessionID: null,
    agentID: options.agentID ?? null, providerID: "openai", modelID: "gpt-6-luna", variant: null,
    records, observedTokens: records * 1_000, unknownTokenRecords: 0, partialRecords: 0,
    input: records * 500, output: records * 500, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    unknownCacheRecords: 0, hostCostUSD: 0, hostCostMissing: 0,
    ...options,
  }
}

test("All aggregates retained, archived and legacy coverage into one summary and model total", async () => {
  const records = [
    record("raw-priced", "openai", "gpt-6-luna", 1_000_000, 0, { apiPrices: [price(1, 0)] }),
    record("raw-legacy", "openai", "gpt-6-luna", 500_000, 0),
  ]
  const report = await build({
    records,
    lifetime: [
      lifetime("project-a", 2, { apiRecords: 2, apiUnknownRecords: 0, apiCost: apiCost(4, 2, 2_000_000) }),
      lifetime("project-a", 2),
    ],
    rollups: [{
      projectID: "project-a", day: 1, records: 3, observedTokens: 3_000, unknownTokenRecords: 0, slices: [],
    }],
  })
  assert.equal(report.apiEquivalent?.retainedUSD, 1)
  assert.equal(report.apiEquivalent?.archivedUSD, 4)
  assert.equal(report.apiEquivalent?.currencies.length, 1)
  assert.equal(report.apiEquivalent?.currencies[0].estimatedAmount, 5)
  assert.equal(report.apiEquivalent?.currencies[0].pricedRecords, 3)
  assert.equal(report.apiEquivalent?.currencies[0].pricedTokens, 3_000_000)
  assert.equal(report.apiEquivalent?.pricedRecords, 3)
  assert.equal(report.apiEquivalent?.unpricedRecords, 6)
  assert.equal(report.apiEquivalent?.legacyUnknownRecords, 6)
  assert.equal(report.apiEquivalent?.archivedRecords, 7)
  const model = report.dimensions.items.find((item) => item.value === "openai/gpt-6-luna")
  assert.equal(model?.apiCosts?.total, 5)
  assert.equal(model?.apiCosts?.pricedRecords, 3)
  assert.equal(model?.apiCosts?.unpricedRecords, 3)
})

test("all-legacy and archived-only reports emit explicit unknown coverage, never hidden", async () => {
  const legacy = await build({
    records: [record("legacy", "openai", "gpt-6-luna", 1_000, 0)],
  })
  assert.deepEqual(legacy.apiEquivalent?.currencies, [])
  assert.equal(legacy.apiEquivalent?.unpricedRecords, 1)
  assert.equal(legacy.apiEquivalent?.legacyUnknownRecords, 1)
  assert.equal(legacy.apiEquivalent?.retainedUSD, null)
  assert.equal(legacy.apiEquivalent?.archivedUSD, null)

  const archivedOnly = await build({
    records: [],
    lifetime: [lifetime("project-a", 2)],
  })
  assert.deepEqual(archivedOnly.apiEquivalent?.currencies, [])
  assert.equal(archivedOnly.apiEquivalent?.unpricedRecords, 2)
  assert.equal(archivedOnly.apiEquivalent?.legacyUnknownRecords, 2)
  assert.equal(archivedOnly.apiEquivalent?.archivedRecords, 2)
  assert.equal(archivedOnly.apiEquivalent?.scope, "selected-range-with-older-cumulative")
})

test("session exclusions hide raw and archived usage but preserve budgets and reversible history", async () => {
  const records = [record("visible", "openai", "model", 10, 0), record("hidden", "openai", "model", 20, 0)]
  records[1].hostProjectID = "ignored"
  const archived = lifetime("ignored", 2)
  archived.hostSessionID = "archived-hidden"
  const input = { records, lifetime: [archived], now: () => 2_000_000_000_000, budgets: [{ id: "all", dimension: "provider" as const, target: "openai", limitTokens: 100 }] }
  const visible = await build(input)
  const hidden = await build({ ...input, view: {
    names: new Map(), merge: new Map(), exclude: new Set(["ignored"]), known: new Set(), fallback: null,
  } })
  assert.equal(hidden.totals.observedTokens, 10)
  assert.equal(hidden.sessions.items.length, 1)
  assert.equal(hidden.sessions.items[0].observedTokens, 10)
  assert.deepEqual(hidden.budgets, visible.budgets)
  const restored = await build(input)
  assert.deepEqual(restored.sessions, visible.sessions)
  assert.deepEqual(restored.totals, visible.totals)
  assert.equal(records.length, 2)
  assert.equal(archived.hostSessionID, "archived-hidden")
})

test("excluded projects are removed from archived totals and dated reports leak no lifetime", async () => {
  const view: ProjectView = {
    names: new Map([["project-a", "Project A"]]),
    merge: new Map(),
    exclude: new Set(["sandbox"]),
    known: new Set(["project-a", "sandbox"]),
    fallback: null,
  }
  const report = await build({
    records: [],
    lifetime: [
      lifetime("project-a", 2),
      lifetime("sandbox", 5),
    ],
    view,
  })
  assert.equal(report.apiEquivalent?.archivedRecords, 2)
  assert.equal(report.apiEquivalent?.unpricedRecords, 2)
  assert.equal(report.apiEquivalent?.legacyUnknownRecords, 2)

  const dated = await build({
    records: [],
    lifetime: [lifetime("project-a", 2)],
    query: { since: 0, limit: 100, offset: 0 },
  })
  assert.equal(dated.apiEquivalent, undefined)
})

test("provider, agent and project rows expose frozen API costs that reconcile the known total", async () => {
  const view: ProjectView = {
    names: new Map([["project-a", "Project A"]]),
    merge: new Map(),
    exclude: new Set(["sandbox"]),
    known: new Set(["project-a", "sandbox"]),
    fallback: null,
  }
  const records = [
    record("priced-agent", "openai", "gpt-6-luna", 1_000_000, 0, { at: 100, apiPrices: [price(1, 0)] }),
    record("legacy-agent", "anthropic", "opus", 500_000, 0, { at: 100 }),
    record("unattributed", "openai", "gpt-6-luna", 1_000_000, 0, { at: 100, apiPrices: [price(1, 0)] }),
  ]
  records[0].hostAgentID = "agent-a"
  records[1].hostAgentID = "agent-b"
  const lifetimeRows = [
    lifetime("project-a", 2, { agentID: "agent-a", apiRecords: 2, apiUnknownRecords: 0, apiCost: apiCost(4, 2, 2_000_000) }),
    lifetime("sandbox", 5, { agentID: "agent-a", apiRecords: 5, apiUnknownRecords: 0, apiCost: apiCost(50, 5, 5_000_000) }),
  ]
  const report = await build({ records, lifetime: lifetimeRows, view })
  const provider = report.dimensions.items.find((item) => item.dimension === "provider" && item.value === "openai")
  const anthropic = report.dimensions.items.find((item) => item.dimension === "provider" && item.value === "anthropic")
  assert.equal(provider?.apiCosts?.total, 6)
  assert.equal(provider?.apiCosts?.pricedRecords, 4)
  assert.equal(anthropic?.apiCosts, null)
  const agentA = report.agentAttribution.dimensions.items.find((item) => item.agentID === "agent-a")
  const agentB = report.agentAttribution.dimensions.items.find((item) => item.agentID === "agent-b")
  assert.equal(agentA?.apiCosts?.total, 5)
  assert.equal(agentB?.apiCosts, null)
  assert.equal(report.agentAttribution.unattributed.apiCosts?.total, 1)
  const project = report.projects.items.find((item) => item.projectID === "project-a")
  assert.equal(project?.apiCosts?.total, 6)
  assert.equal(report.projects.apiCosts?.total, 6)
  assert.equal(report.agentAttribution.apiCosts?.total, 6)
  assert.equal(report.projects.items.some((item) => item.projectID === "sandbox"), false)
  // Known USD reconciles across provider, agent and project rows and the global summary.
  const known = report.apiEquivalent?.currencies[0].estimatedAmount
  assert.equal(known, 6)
  assert.equal(provider?.apiCosts?.total, known)
  assert.equal((agentA?.apiCosts?.total ?? 0) + (report.agentAttribution.unattributed.apiCosts?.total ?? 0), known)
  assert.equal(project?.apiCosts?.total, known)

  const dated = await build({ records, lifetime: lifetimeRows, view, query: { since: 0, limit: 100, offset: 0 } })
  const datedProvider = dated.dimensions.items.find((item) => item.dimension === "provider" && item.value === "openai")
  assert.equal(datedProvider?.apiCosts?.total, 2)
  assert.equal(dated.projects.apiCosts?.total, 2)
  assert.equal(dated.agentAttribution.apiCosts?.total, 2)
  assert.equal(dated.apiEquivalent?.currencies[0].estimatedAmount, 2)
})

test("plugin-attribution rows carry host-record API costs without changing the global total", async () => {
  const host = record("plugin-host", "openai", "gpt-6-luna", 1_000_000, 0, { apiPrices: [price(1, 0)] })
  host.hostSessionID = "session-plugin"
  const report = await build({
    records: [host],
    claims: [{
      projectID: "project-a", pluginID: "plugin-x", pluginName: "Plugin X",
      hostSessionID: "session-plugin", claimedAt: 100,
    }],
  })
  assert.equal(report.pluginAttribution.dimensions.items[0].apiCosts?.total, 1)
  assert.equal(report.apiEquivalent?.currencies[0].estimatedAmount, 1)
})

test("direct plugin API costs are separate from the global host equivalent", async () => {
  const hosted = await build({
    records: [record("host", "openai", "gpt-6-luna", 1_000_000, 0, { apiPrices: [price(1, 0)] })],
  })
  const directRecord = {
    projectID: "project-a", pluginID: "plugin-x", pluginName: "Plugin X", usageID: "usage-1",
    providerID: "openai", modelID: "gpt-6-luna", variant: null, reportedAt: 100,
    counts: { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    partial: false,
    apiPrice: { recordedAt: 100, source: "catalog", prices: [price(1, 0)] },
  }
  const directRollup = {
    projectID: "project-a", day: 1, records: 1, observedTokens: 1_000_000, unknownTokenRecords: 0,
    partialRecords: 0, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    slices: [{
      pluginID: "plugin-x", pluginName: "Plugin X", providerID: "openai", modelID: "gpt-6-luna",
      variant: null, records: 1, observedTokens: 1_000_000, unknownTokenRecords: 0, partialRecords: 0,
      input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, unknownCacheRecords: 0,
      apiCost: apiCost(2, 1, 1_000_000), apiRecords: 1, apiUnknownRecords: 0,
    }],
  }
  const withDirect = await build({
    records: [record("host", "openai", "gpt-6-luna", 1_000_000, 0, { apiPrices: [price(1, 0)] })],
    direct: { records: [directRecord], rollups: [directRollup] },
  })
  assert.equal(withDirect.directUsage.apiCosts?.total, 3)
  assert.equal(withDirect.directUsage.dimensions.items[0].apiCosts?.total, 3)
  assert.equal(withDirect.apiEquivalent?.currencies[0].estimatedAmount, 1)
  assert.equal(hosted.apiEquivalent?.currencies[0].estimatedAmount, 1)
})

test("an actual DirectUsageLedger snapshot drives raw, folded All and dated direct totals", async () => {
  const storage = new MemoryStorage()
  const start = 2_000_000_000_000
  let clock = start
  const ledger = new DirectUsageLedger(storage as unknown as StorageDomain, {
    now: () => clock,
    retentionMs: 50,
    apiPrice: async () => [price(2, 4)],
  })
  await ledger.record(directInput("a"))
  await ledger.record(directInput("b"))
  await ledger.record(directInput("c", "project-b"))

  const buildWith = (query: ReportQuery) => buildQuartermasterReport({
    projectID: "project-a",
    tokenLedger: {
      list: async () => [record("host", "openai", "gpt-6-luna", 1_000_000, 0, { apiPrices: [price(1, 0)] })],
      listRollups: async () => [],
      listLifetime: async () => [],
    },
    errorLedger: { list: async () => [] },
    attributionLedger: { list: async () => [] },
    directUsageLedger: ledger,
    budgets: undefined,
    tokenRates: undefined,
    catalog: async () => ({ prices: empty, contextLimits: new Map() }),
  }, query, false)

  const raw = await buildWith({ limit: 100, offset: 0 })
  assert.equal(raw.directUsage.apiCosts?.total, 6)
  assert.equal(raw.directUsage.dimensions.items[0].apiCosts?.total, 6)
  assert.equal(raw.directUsage.archived.records, 0)
  // Direct plugin work never leaks into the host API equivalent.
  assert.equal(raw.apiEquivalent?.currencies[0].estimatedAmount, 1)

  clock = start + 86_400_000 + 1
  const all = await buildWith({ limit: 100, offset: 0 })
  assert.equal(all.directUsage.archived.records, 3)
  assert.equal(all.directUsage.apiCosts?.total, 6)
  assert.equal(all.directUsage.dimensions.items[0].apiCosts?.total, 6)
  assert.equal(all.apiEquivalent?.currencies[0].estimatedAmount, 1)

  const dated = await buildWith({ since: start + 1, limit: 100, offset: 0 })
  assert.equal(dated.directUsage.archived.records, 0)
  assert.equal(dated.directUsage.apiCosts, null)
  assert.equal(dated.directUsage.dimensions.items.length, 0)
})

test("direct usage respects project exclusions for raw and archived API costs", async () => {
  const view: ProjectView = {
    names: new Map([["project-a", "Project A"]]),
    merge: new Map(),
    exclude: new Set(["sandbox"]),
    known: new Set(["project-a", "sandbox"]),
    fallback: null,
  }
  const directRecord = (projectID: string, usageID: string) => ({
    projectID, pluginID: "opr", pluginName: "OPR", usageID,
    providerID: "openai", modelID: "gpt-6-luna", variant: null, reportedAt: 100,
    counts: { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    partial: false,
    apiPrice: { recordedAt: 100, source: "catalog", prices: [price(2, 0)] },
  })
  const rollup = (projectID: string) => ({
    projectID, day: 1, records: 1, observedTokens: 1_000_000, unknownTokenRecords: 0,
    partialRecords: 0, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    slices: [{
      pluginID: "opr", pluginName: "OPR", providerID: "openai", modelID: "gpt-6-luna",
      variant: null, records: 1, observedTokens: 1_000_000, unknownTokenRecords: 0, partialRecords: 0,
      input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, unknownCacheRecords: 0,
      apiCost: apiCost(2, 1, 1_000_000), apiRecords: 1, apiUnknownRecords: 0,
    }],
  })
  const report = await build({
    records: [],
    view,
    direct: {
      records: [directRecord("project-a", "a"), directRecord("sandbox", "b")],
      rollups: [rollup("project-a"), rollup("sandbox")],
    },
  })
  assert.equal(report.directUsage.apiCosts?.total, 4)
  assert.equal(report.directUsage.dimensions.items[0].apiCosts?.total, 4)
})

test("mixed priced raw and unsplit legacy archive keep unknown coverage in section totals", async () => {
  const slice = {
    agentID: "agent-a", providerID: "openai", modelID: "gpt-6-luna", variant: null,
    records: 2, observedTokens: 2_000, unknownTokenRecords: 0, partialRecords: 0,
    input: 2_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    unknownCacheRecords: 0, hostCostUSD: 0, hostCostMissing: 0,
    apiCost: apiCost(2, 2, 2_000_000), apiRecords: 2, apiUnknownRecords: 0,
  }
  const rollup: TokenRollup = {
    projectID: "project-a", day: 1, records: 5, observedTokens: 5_000,
    unknownTokenRecords: 0, slices: [slice],
  }
  const records = [record("raw", "openai", "gpt-6-luna", 1_000_000, 0, { apiPrices: [price(1, 0)] })]
  records[0].hostAgentID = "agent-a"
  const report = await build({ records, rollups: [rollup] })
  assert.equal(report.projects.apiCosts?.total, 3)
  assert.equal(report.projects.apiCosts?.pricedRecords, 3)
  assert.equal(report.projects.apiCosts?.unpricedRecords, 3)
  assert.equal(report.agentAttribution.apiCosts?.total, 3)
  assert.equal(report.agentAttribution.apiCosts?.unpricedRecords, 3)

  const dated = await build({ records, rollups: [rollup], query: { since: 0, limit: 100, offset: 0 } })
  assert.equal(dated.projects.apiCosts?.total, 1)
  assert.equal(dated.projects.apiCosts?.unpricedRecords, 0)
})
