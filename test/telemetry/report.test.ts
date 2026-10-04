import assert from "node:assert/strict"
import test from "node:test"
import type { Schema } from "effect"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { parseConfig } from "../../src/config.ts"
import { projectRetryError, ProviderErrorLedger } from "../../src/telemetry/errors.ts"
import { PluginAttributionLedger } from "../../src/telemetry/attribution.ts"
import { TokenLedger } from "../../src/telemetry/ledger.ts"
import { buildQuartermasterReport } from "../../src/telemetry/report.ts"
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
  const deps = { projectID: "project-a", tokenLedger, errorLedger, attributionLedger, budgets: config.budgets, tokenRates: config.tokenRates, now: () => 1_000 }
  const page = await buildQuartermasterReport(deps, { since: 850, until: 999, limit: 2, offset: 0 }, true)
  assert.equal(page.projectID, "project-a")
  assert.deepEqual(page.totals, { records: 3, observedTokens: 24, unknownTokenRecords: 1, complete: false })
  assert.deepEqual(page.costs, {
    status: "estimated-not-billed", basis: "input-output-only-per-million", complete: false,
    pricedRecords: 2, pricedTokens: 24, unpricedRecords: 1, unpricedTokens: 0, unknownTokenRecords: 1,
    currencies: [{
      currency: "USD", estimatedAmount: 0.000022, pricedRecords: 2, pricedTokens: 24,
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
  assert.deepEqual(page.planAttribution, {
    status: "unsupported", reasonCode: "no-exact-plan-step-link", complete: false, unknownRecords: 3,
  })
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
