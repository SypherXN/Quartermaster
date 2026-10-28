import assert from "node:assert/strict"
import test from "node:test"
import type { Schema } from "effect"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { parseConfig } from "../../src/config.ts"
import { projectRetryError, ProviderErrorLedger } from "../../src/telemetry/errors.ts"
import { PluginAttributionLedger } from "../../src/telemetry/attribution.ts"
import { TokenLedger } from "../../src/telemetry/ledger.ts"
import { buildQuartermasterReport } from "../../src/telemetry/report.ts"
import { sessionKey } from "../../src/telemetry/session-key.ts"
import type { TokenTelemetryRecord } from "../../src/telemetry/types.ts"

class MemoryStorage implements StorageDomain {
  values = new Map<string, Schema.Json>()
  async get(key: string) { return this.values.get(key) }
  async set(key: string, value: Schema.Json) { this.values.set(key, value) }
  async remove(key: string) { this.values.delete(key) }
  async scan(options: Parameters<StorageDomain["scan"]>[0]) {
    const keys = [...this.values.keys()].filter((key) => key.startsWith(options.prefix) && (!options.after || key > options.after)).sort()
    const page = keys.slice(0, options.limit ?? 100)
    return { entries: page.map((key) => ({ key, value: this.values.get(key)! })), ...(keys.length > page.length ? { next: page.at(-1)! } : {}) }
  }
}

function token(id: string, projectID: string, providerID: string | null, modelID: string | null, input: number | null, at: number): TokenTelemetryRecord {
  return {
    hostContractVersion: "2.0.18", hostEventID: id, sourceEvent: "session.step.ended",
    hostSessionID: `session-${id}`, hostMessageID: `message-${id}`, hostProjectID: projectID,
    parentSessionID: null, hostAgentID: id === "a" || id === "child" ? "reviewer" : null,
    providerID, modelID, variant: null, completedAt: at,
    counts: input === null ? null : { input, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    usageStatus: input === null ? "missing" : "reported",
    partial: false,
  }
}

const retry = (status: number) => ({ sessionID: "session", model: { providerID: "provider-a", id: "model-a" }, error: { status }, attempt: 1 })

test("report is project-scoped, bounded, unknown-aware, and rereads ledgers", async () => {
  const storage = new MemoryStorage()
  const tokenLedger = new TokenLedger(storage, { now: () => 1_000 })
  const errorLedger = new ProviderErrorLedger(storage, () => 1_000)
  const attributionLedger = new PluginAttributionLedger(storage, () => 1_000)
  await tokenLedger.ingest(token("a", "project-a", "provider-a", "model-a", 10, 900))
  await tokenLedger.ingest(token("b", "project-a", null, null, null, 950))
  await tokenLedger.ingest(token("child", "project-a", "provider-a", "model-a", 4, 925))
  await tokenLedger.ingest(token("other", "project-b", "provider-b", "model-b", 900, 975))
  await attributionLedger.claim("project-a", "plugin-a", "Plugin A", ["session-a", "session-child"])
  await attributionLedger.claim("project-a", "plugin-a", "Plugin A", ["session-a"])
  await attributionLedger.claim("project-a", "plugin-b", "Plugin B", ["session-b"])
  await attributionLedger.claim("project-a", "plugin-c", "Plugin C", ["session-b"])
  await attributionLedger.claim("project-a", "plugin-a", "Plugin A", ["session-other"])
  await attributionLedger.claim("project-a", "unmatched-plugin", "Unmatched", ["unused-session"])
  await errorLedger.ingest(projectRetryError(retry(429), "error-a", 960, "project-a")!)
  await errorLedger.ingest(projectRetryError(retry(503), "error-b", 970, "project-b")!)
  await errorLedger.ingest(projectRetryError(retry(429), "error-unknown", 980)!)
  const config = parseConfig({
    plans: { p: ["provider-a/model-a"] },
    tokenRates: [{ providerID: "provider-a", modelID: "model-a", inputPerMillion: 0.5, outputPerMillion: 1.5, currency: "USD", source: "test fixture", asOf: 800 }],
    budgets: [
      { id: "project-cap", dimension: "project", limitTokens: 10, windowMs: 10_000 },
      { id: "plugin-cap", dimension: "plugin", target: "plugin-a", limitTokens: 10, windowMs: 10_000 },
    ],
  })
  const deps = { projectID: "project-a", tokenLedger, errorLedger, attributionLedger, budgets: config.budgets, tokenRates: config.tokenRates, plans: config.plans, now: () => 1_000 }
  const page = await buildQuartermasterReport(deps, { since: 850, until: 999, limit: 2, offset: 0 }, true)
  assert.equal(page.projectID, "project-a")
  assert.deepEqual(page.totals, {
    records: 3, observedTokens: 24, unknownTokenRecords: 1, partialTokenRecords: 0,
    input: 14, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, complete: false,
  })
  assert.deepEqual(page.costs, {
    status: "estimated-not-billed", basis: "input-output-cache-per-million", complete: false,
    pricedRecords: 2, pricedTokens: 24, unpricedRecords: 1, unpricedTokens: 0, unknownTokenRecords: 1,
    cacheUnpricedRecords: 0, hostReported: { currency: "USD", amount: null, records: 0, missingRecords: 3 },
    currencies: [{
      currency: "USD", estimatedAmount: 0.000022, pricedRecords: 2, pricedTokens: 24, source: "config",
      rates: [{ providerID: "provider-a", modelID: "model-a", inputPerMillion: 0.5, outputPerMillion: 1.5, currency: "USD", source: "test fixture", asOf: 800 }],
    }],
  })
  assert.equal(page.freshness.latestObservedAt, 950)
  assert.equal(page.freshness.complete, false)
  assert.equal(page.errors.total, 1)
  assert.equal(page.errors.complete, false)
  assert.equal(page.errors.byClassification["rate-limit"].count, 1)
  assert.equal(page.pluginAttribution.attribution, "self-reported-unverified")
  assert.equal(page.pluginAttribution.verified, false)
  assert.equal(page.pluginAttribution.unknownRecords, 1)
  assert.equal(page.pluginAttribution.ambiguousRecords, 1)
  assert.deepEqual(page.pluginAttribution.dimensions.items, [{
    pluginID: "plugin-a", pluginName: "Plugin A", attribution: "self-reported-unverified",
    records: 2, observedTokens: 24, unknownTokenRecords: 0,
  }])
  assert.deepEqual(page.agentAttribution.dimensions.items, [{
    agentID: "reviewer", evidence: "exact-assistant-message", records: 2,
    observedTokens: 24, unknownTokenRecords: 0,
  }])
  assert.equal(page.agentAttribution.unknownRecords, 1)
  assert.equal(page.planAttribution.status, "model-match-unique")
  assert.equal(page.planAttribution.evidence, "exact-model-reference")
  assert.equal(page.planAttribution.complete, false)
  assert.equal(page.planAttribution.totalRecords, 3)
  assert.equal(page.planAttribution.unknownRecords, 1)
  assert.equal(page.planAttribution.ambiguousRecords, 0)
  assert.deepEqual(page.planAttribution.dimensions.items, [{
    plan: "p", evidence: "exact-model-reference", records: 2, observedTokens: 24, unknownTokenRecords: 0,
  }])
  assert.equal(page.dimensions.nextOffset, 2)
  assert.equal(page.budgets[0].remainingTokens, null)
  assert.equal(page.budgets[0].complete, false)
  assert.equal(page.budgets[1].observedTokens, 0)
  assert.equal(page.budgets[1].unknownRecords, 3)
  assert.equal(page.refresh, "reread")
  const next = await buildQuartermasterReport(deps, { limit: 2, offset: page.dimensions.nextOffset! }, false)
  assert.equal(next.dimensions.offset, 2)
  assert.equal(next.totals.records, 3)
  assert.equal(next.refresh, "not-requested")
  assert.equal(JSON.stringify(page).includes("project-b"), false)
  assert.equal(JSON.stringify(page).includes("error-unknown"), false)
  assert.equal(JSON.stringify(page).includes("session-a"), false)
  assert.equal(JSON.stringify(page).includes("message-a"), false)
  const projectB = await buildQuartermasterReport({ ...deps, projectID: "project-b" }, { limit: 2, offset: 0 }, false)
  assert.equal(projectB.pluginAttribution.unknownRecords, 1)
  assert.deepEqual(projectB.pluginAttribution.dimensions.items, [])
  assert.equal(projectB.agentAttribution.unknownRecords, 1)
  assert.equal(projectB.planAttribution.unknownRecords, 1)
})

test("sessions roll child sessions into their root and report context occupancy", async () => {
  const row = (
    hostEventID: string, hostSessionID: string, parentSessionID: string | null,
    completedAt: number, input: number, output: number,
  ): TokenTelemetryRecord => ({
    hostContractVersion: "2.0.18", hostEventID, sourceEvent: "session.step.ended",
    hostSessionID, hostMessageID: `message-${hostEventID}`, hostProjectID: "project-a",
    parentSessionID, hostAgentID: null, providerID: "provider-a", modelID: "model-a", variant: null,
    completedAt, counts: { input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    usageStatus: "reported", partial: false,
  })
  const records = [
    row("root-step", "session-root", null, 100, 80, 20),
    row("child-step", "session-child", "session-root", 200, 50, 10),
  ]
  const page = await buildQuartermasterReport({
    projectID: "project-a",
    tokenLedger: { list: async () => records, listRollups: async () => [] },
    errorLedger: { list: async () => [] },
    attributionLedger: { list: async () => [] },
    budgets: [],
    tokenRates: [],
    catalog: async () => ({ prices: new Map(), contextLimits: new Map([["provider-a/model-a", 1_000]]) }),
    now: () => 300,
  }, { limit: 10, offset: 0 }, false)

  assert.equal(page.sessions.total, 1)
  const [session] = page.sessions.items
  assert.equal(session.sessionKey.length, 12)
  assert.equal(session.sessions, 2)
  assert.equal(session.messages, 2)
  assert.equal(session.records, 2)
  assert.equal(session.observedTokens, 160)
  assert.equal(session.lastInputTokens, 50)
  assert.equal(session.contextLimit, 1_000)
  assert.equal(session.contextPercent, 5)
  assert.equal(session.childTokenShare, 60 / 160)
  assert.equal(session.childHostCostShare, null)
  assert.equal(session.cacheHitRate, null)
  assert.equal(session.cacheQualityComplete, true)
  const serialized = JSON.stringify(page)
  assert.equal(serialized.includes("session-root"), false)
  assert.equal(serialized.includes("message-root-step"), false)
})

test("sessions rank by host cost and report cache quality and child share", async () => {
  const step = (
    hostEventID: string, hostSessionID: string, parentSessionID: string | null,
    completedAt: number, input: number, output: number, cacheRead: number, cacheWrite: number,
    hostCostUSD?: number, partial = false,
  ): TokenTelemetryRecord => ({
    hostContractVersion: "2.0.18", hostEventID, sourceEvent: "session.step.ended",
    hostSessionID, hostMessageID: `message-${hostEventID}`, hostProjectID: "project-a",
    parentSessionID, hostAgentID: null, providerID: "provider-a", modelID: "model-a", variant: null,
    completedAt, counts: { input, output, reasoning: 0, cacheRead, cacheWrite },
    usageStatus: "reported", partial, ...(hostCostUSD === undefined ? {} : { hostCostUSD }),
  })
  const page = await buildQuartermasterReport({
    projectID: "project-a",
    tokenLedger: { list: async () => [
      step("cheap", "cheap-root", null, 50, 1000, 0, 0, 0, 0.1),
      step("before", "pricey", null, 100, 10, 0, 0, 10, 2),
      step("same-time", "pricey", null, 150, 0, 0, 0, 7, 0),
      step("rebuild", "pricey", null, 200, 0, 10, 30, 40, 0.5),
      step("later", "pricey", null, 250, 0, 0, 0, 5, 0),
      step("child", "child-of-pricey", "pricey", 300, 20, 0, 60, 0, 1.5),
      step("gap", "gap-root", null, 400, 5000, 0, 0, 0),
      step("fuzzy", "fuzzy-root", null, 80, 4, 1, 3, 1, 0.01, true),
    ], listRollups: async () => [] },
    errorLedger: { list: async () => [] },
    attributionLedger: { list: async () => [] },
    compactionLedger: { list: async () => [{
      hostEventID: "compact-1", projectID: "project-a", sessionKey: sessionKey("pricey"),
      sourceEvent: "session.compaction.ended", reason: "auto", providerID: null, modelID: null,
      variant: null, completedAt: 150, counts: null, usageStatus: "missing", partial: false,
    }] },
    budgets: [],
    tokenRates: [],
    now: () => 500,
  }, { limit: 10, offset: 0 }, false)

  assert.deepEqual(page.sessions.items.map((item) => item.sessionKey), [
    sessionKey("pricey"), sessionKey("cheap-root"), sessionKey("fuzzy-root"), sessionKey("gap-root"),
  ])
  const pricey = page.sessions.items[0]
  assert.equal(pricey.hostCostUSD, 4)
  assert.equal(pricey.hostCostMissing, 0)
  assert.equal(pricey.observedTokens, 40)
  assert.equal(pricey.cacheHitRate, 90 / 152)
  assert.equal(pricey.cacheWriteAfterCompaction, 40)
  assert.equal(pricey.cacheWriteOther, 22)
  assert.equal(pricey.cacheQualityComplete, true)
  assert.equal(pricey.childTokenShare, 0.5)
  assert.equal(pricey.childHostCostShare, 1.5 / 4)
  assert.equal(page.sessions.items[1].hostCostUSD, 0.1)
  assert.equal(page.sessions.items[1].cacheHitRate, null)
  assert.equal(page.sessions.items[2].cacheHitRate, null)
  assert.equal(page.sessions.items[2].cacheQualityComplete, false)
  assert.equal(page.sessions.items[3].hostCostUSD, null)
  assert.equal(page.sessions.items[3].hostCostMissing, 1)
  assert.equal(page.sessions.items[3].childHostCostShare, null)
  const serialized = JSON.stringify(page)
  assert.equal(serialized.includes("pricey"), false)
  assert.equal(serialized.includes("child-of-pricey"), false)
})

test("direct plugin usage stays out of host totals and hides the usage id", async () => {
  const page = await buildQuartermasterReport({
    projectID: "project-a",
    tokenLedger: { list: async () => [], listRollups: async () => [] },
    errorLedger: { list: async () => [] },
    attributionLedger: { list: async () => [] },
    directUsageLedger: { list: async () => [{
      projectID: "project-a", pluginID: "opr", pluginName: "OPR", usageID: "jev-call-secret",
      providerID: "jev", modelID: "review", variant: null, reportedAt: 150, partial: true,
      counts: { input: 1200, output: 80, reasoning: 0, cacheRead: 400, cacheWrite: 0 },
    }] },
    budgets: [],
    tokenRates: [],
    now: () => 300,
  }, { limit: 10, offset: 0 }, false)

  assert.equal(page.totals.observedTokens, 0)
  assert.equal(page.directUsage.records, 1)
  assert.equal(page.directUsage.observedTokens, 1280)
  assert.equal(page.directUsage.partialRecords, 1)
  assert.equal(page.directUsage.verified, false)
  assert.equal(page.directUsage.dimensions.items[0]?.pluginID, "opr")
  assert.equal(JSON.stringify(page).includes("jev-call-secret"), false)
})

test("compaction stays beside its model and out of host totals", async () => {
  const page = await buildQuartermasterReport({
    projectID: "project-a",
    tokenLedger: { list: async () => [token("step", "project-a", "provider-a", "model-a", 10, 100)], listRollups: async () => [] },
    errorLedger: { list: async () => [] },
    attributionLedger: { list: async () => [] },
    compactionLedger: { list: async () => [{
      hostEventID: "cmp-1",
      projectID: "project-a",
      sessionKey: null,
      sourceEvent: "session.compaction.ended" as const,
      reason: "auto" as const,
      providerID: "provider-b",
      modelID: "summarizer",
      variant: null,
      completedAt: 200,
      counts: { input: 800, output: 40, reasoning: 0, cacheRead: 200, cacheWrite: 0 },
      usageStatus: "reported" as const,
      partial: false,
    }] },
    budgets: [],
    tokenRates: [],
    catalog: async () => ({ prices: new Map(), contextLimits: new Map([["provider-b/summarizer", 2_000]]) }),
    now: () => 300,
  }, { limit: 10, offset: 0 }, false)

  assert.equal(page.totals.observedTokens, 15)
  assert.equal(page.compaction.includedInTotals, false)
  assert.equal(page.compaction.records, 1)
  assert.equal(page.compaction.observedTokens, 840)
  const [item] = page.compaction.dimensions.items
  assert.equal(item?.modelID, "summarizer")
  assert.equal(item?.lastInputTokens, 1_000)
  assert.equal(item?.contextLimit, 2_000)
  assert.equal(item?.contextPercent, 50)
  assert.equal(page.dimensions.items.some((row) => row.value === "provider-b"), false)
  assert.equal(JSON.stringify(page.costs).includes("840"), false)
})

function breakdownToken(overrides: Partial<TokenTelemetryRecord> & Pick<TokenTelemetryRecord, "hostEventID">): TokenTelemetryRecord {
  const id = overrides.hostEventID
  const counts = overrides.counts === undefined
    ? { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    : overrides.counts
  return {
    hostContractVersion: "2.0.18",
    hostEventID: id,
    sourceEvent: overrides.sourceEvent ?? "session.step.ended",
    hostSessionID: overrides.hostSessionID ?? `session-${id}`,
    hostMessageID: overrides.hostMessageID ?? `message-${id}`,
    hostProjectID: overrides.hostProjectID ?? "project-a",
    parentSessionID: overrides.parentSessionID ?? null,
    hostAgentID: overrides.hostAgentID ?? "agent-1",
    providerID: overrides.providerID ?? "provider-a",
    modelID: overrides.modelID ?? "model-a",
    variant: overrides.variant ?? null,
    completedAt: overrides.completedAt ?? 900,
    counts,
    usageStatus: overrides.usageStatus ?? (counts === null ? "missing" : "reported"),
    partial: overrides.partial ?? false,
  }
}

test("report breakdown aggregates flat usage rows for dashboard grouping", async () => {
  const storage = new MemoryStorage()
  const tokenLedger = new TokenLedger(storage, { now: () => 1_000 })
  const errorLedger = new ProviderErrorLedger(storage, () => 1_000)
  const attributionLedger = new PluginAttributionLedger(storage, () => 1_000)
  const deps = {
    projectID: "project-a",
    tokenLedger,
    errorLedger,
    attributionLedger,
    budgets: undefined,
    tokenRates: undefined,
    now: () => 1_000,
  }

  // (a) same agent + model aggregates
  await tokenLedger.ingest(breakdownToken({ hostEventID: "agg-1", hostAgentID: "agent-1", counts: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }))
  await tokenLedger.ingest(breakdownToken({ hostEventID: "agg-2", hostAgentID: "agent-1", counts: { input: 4, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }))

  // (b) second model for same agent
  await tokenLedger.ingest(breakdownToken({ hostEventID: "model-b", hostAgentID: "agent-1", modelID: "model-b", counts: { input: 3, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }))

  // (c) plugin-attributed vs unattributed
  await tokenLedger.ingest(breakdownToken({
    hostEventID: "plugin-row",
    hostSessionID: "session-plugin",
    hostAgentID: "agent-2",
    counts: { input: 7, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  }))
  await tokenLedger.ingest(breakdownToken({
    hostEventID: "no-plugin",
    hostSessionID: "session-none",
    hostAgentID: "agent-2",
    counts: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  }))
  await attributionLedger.claim("project-a", "plugin-x", "Plugin X", ["session-plugin"])

  // (d) missing usage
  await tokenLedger.ingest(breakdownToken({
    hostEventID: "missing",
    hostAgentID: "agent-3",
    counts: null,
    usageStatus: "missing",
  }))

  // (e) cache and reasoning sub-counts
  await tokenLedger.ingest(breakdownToken({
    hostEventID: "cache",
    hostAgentID: "agent-4",
    counts: { input: 2, output: 2, reasoning: 9, cacheRead: 100, cacheWrite: 50 },
  }))

  const report = await buildQuartermasterReport(deps, { limit: 100, offset: 0 }, false)
  assert.equal(report.breakdown.attribution, "self-reported-unverified")
  assert.equal(report.breakdown.complete, false)

  const agg = report.breakdown.items.find((row) => row.agentID === "agent-1" && row.modelID === "model-a")
  assert.ok(agg)
  assert.equal(agg.records, 2)
  assert.equal(agg.observedTokens, 10 + 5 + 4 + 1)
  assert.equal(agg.input, 14)
  assert.equal(agg.output, 6)
  assert.equal(agg.pluginID, null)

  const modelB = report.breakdown.items.filter((row) => row.agentID === "agent-1" && row.modelID === "model-b")
  assert.equal(modelB.length, 1)
  assert.equal(modelB[0].observedTokens, 5)

  const pluginRow = report.breakdown.items.find((row) => row.agentID === "agent-2" && row.pluginID === "plugin-x")
  assert.ok(pluginRow)
  assert.equal(pluginRow.pluginName, "Plugin X")
  assert.equal(pluginRow.observedTokens, 10)

  const bareRow = report.breakdown.items.find((row) => row.agentID === "agent-2" && row.pluginID === null && row.observedTokens === 2)
  assert.ok(bareRow)

  const missingRow = report.breakdown.items.find((row) => row.agentID === "agent-3")
  assert.ok(missingRow)
  assert.equal(missingRow.unknownTokenRecords, 1)
  assert.equal(missingRow.input, 0)
  assert.equal(missingRow.output, 0)
  assert.equal(missingRow.observedTokens, 0)

  const cacheRow = report.breakdown.items.find((row) => row.agentID === "agent-4")
  assert.ok(cacheRow)
  assert.equal(cacheRow.cacheRead, 100)
  assert.equal(cacheRow.cacheWrite, 50)
  assert.equal(cacheRow.reasoning, 9)
})
