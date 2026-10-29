import assert from "node:assert/strict"
import test from "node:test"
import type { Schema } from "effect"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import type { Context } from "@opencode/plugin/promise/plugin"
import { parseConfig } from "../../src/config.ts"
import { registerQuartermasterRpc, requestReport, type ReportingServices } from "../../src/rpc.ts"
import { consumeTokenEvents } from "../../src/telemetry/collector.ts"
import { ProviderErrorLedger, projectRetryError } from "../../src/telemetry/errors.ts"
import { PluginAttributionLedger } from "../../src/telemetry/attribution.ts"
import { TokenLedger } from "../../src/telemetry/ledger.ts"
import { projectTokenEvents } from "../../src/telemetry/types.ts"

class MemoryStorage implements StorageDomain {
  values = new Map<string, Schema.Json>()
  async get(key: string) { return this.values.get(key) }
  async set(key: string, value: Schema.Json) { this.values.set(key, value) }
  async remove(key: string) { this.values.delete(key) }
  async scan(options: Parameters<StorageDomain["scan"]>[0]) {
    const keys = [...this.values.keys()].filter((key) => key.startsWith(options.prefix)).sort()
    const entries = keys.slice(0, options.limit ?? 100).map((key) => ({ key, value: this.values.get(key)! }))
    return { entries }
  }
}

const step = (id: string, sessionID: string, input: number, output: number) => ({
  id, created: 1000, type: "session.step.ended",
  data: { sessionID, assistantMessageID: `message-${id}`, tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } } },
})

async function* events(items: unknown[]) { yield* items }

test("synthetic host-event replay reconciles to the active-project RPC report", async () => {
  const storage = new MemoryStorage()
  const tokenLedger = new TokenLedger(storage, { now: () => 2000 })
  const errorLedger = new ProviderErrorLedger(storage, () => 2000)
  const attributionLedger = new PluginAttributionLedger(storage, () => 2000)
  const projects: Record<string, string> = { a: "project-a", b: "project-b" }
  const collector = { session: {
    get: async ({ sessionID }: { sessionID: string }) => {
      if (!projects[sessionID]) throw new Error("unknown project")
      return { projectID: projects[sessionID], parentID: null }
    },
    context: async () => [
      { type: "assistant", id: "message-event-a", agent: "reviewer" },
      { type: "assistant", id: "message-event-a2", agent: "reviewer" },
      { type: "assistant", id: "message-event-b", agent: "writer" },
    ],
  } }
  const signal = new AbortController().signal
  const first = step("event-a", "a", 10, 5)
  await consumeTokenEvents(collector as never, tokenLedger, events([first]), signal)
  await consumeTokenEvents(collector as never, tokenLedger, events([first]), signal)
  await consumeTokenEvents(collector as never, tokenLedger, events([step("event-a2", "a", 2, 3), step("event-b", "b", 100, 100)]), signal)
  await consumeTokenEvents(collector as never, tokenLedger, events([step("event-unknown", "missing", 9, 9)]), signal)
  const modelRecord = projectTokenEvents([step("event-model", "a", 1, 1)], () => ({
    projectID: "project-a",
    model: { providerID: "provider-a", modelID: "model-a" },
  }))[0]
  await tokenLedger.ingest(modelRecord!)
  await errorLedger.ingest(projectRetryError({ sessionID: "a", model: { providerID: "provider-a", id: "model-a" }, error: { status: 429 }, attempt: 1 }, "retry-a", 1500, "project-a")!)
  await errorLedger.ingest(projectRetryError({ sessionID: "b", model: { providerID: "provider-b", id: "model-b" }, error: { status: 503 }, attempt: 1 }, "retry-b", 1600, "project-b")!)

  const config = parseConfig({
    plans: { p: ["provider-a/model-a"] },
    budgets: [{ id: "cap", dimension: "project", limitTokens: 1, windowMs: 10000 }],
    tokenRates: [{ providerID: "provider-a", modelID: "model-a", inputPerMillion: 2, outputPerMillion: 4, currency: "USD", source: "fixture", asOf: 1000 }],
  })
  const reporting: ReportingServices = { projectID: "project-a", tokenLedger, errorLedger, attributionLedger, budgets: config.budgets, tokenRates: config.tokenRates, now: () => 2000 }
  let handlers: Record<string, (input: unknown, call: never) => unknown> | undefined
  const rpc = Object.assign(() => ({ report: (input: unknown, options: unknown) => handlers!.report(input, options as never) }), {
    register: async (_definition: unknown, methods: typeof handlers) => { handlers = methods; return { dispose: async () => {} } },
  })
  const ctx = { rpc, model: { list: async () => ({ data: [] }) } }
  await registerQuartermasterRpc(ctx as unknown as Pick<Context, "rpc" | "model">, config, undefined, undefined, reporting)
  const report = await requestReport(ctx as unknown as Pick<Context, "rpc">, { refresh: true })
  assert.equal(report.status, "ok")
  if (report.status !== "ok") return
  assert.equal(report.totals.records, 3)
  assert.equal(report.totals.observedTokens, 22)
  assert.equal(report.costs.pricedTokens, 2)
  assert.equal(report.costs.unpricedTokens, 20)
  assert.equal(report.costs.complete, false)
  assert.equal(report.costs.currencies[0].estimatedAmount, 0.000006)
  assert.deepEqual(report.costs.currencies[0].rates, [{
    providerID: "provider-a", modelID: "model-a", inputPerMillion: 2, outputPerMillion: 4,
    currency: "USD", source: "fixture", asOf: 1000,
  }])
  assert.equal(report.dimensions.items.some((row) => row.dimension === "model" && row.value === "provider-a/model-a"), true)
  assert.equal(report.dimensions.items.some((row) => row.dimension === "provider" && row.value === null), true)
  assert.deepEqual(report.agentAttribution.dimensions.items, [{
    agentID: "reviewer", evidence: "exact-assistant-message", records: 2,
    observedTokens: 20, unknownTokenRecords: 0,
    partialRecords: 0, input: 12, output: 8, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    unknownCacheRecords: 0, hostCostUSD: null, hostCostMissing: 2, cacheHitRate: null,
  }])
  assert.equal(report.agentAttribution.unknownRecords, 1)
  assert.equal(report.planAttribution.status, "model-match-unique")
  assert.equal(report.planAttribution.evidence, "exact-model-reference")
  assert.equal(report.planAttribution.complete, false)
  assert.equal(report.planAttribution.totalRecords, 3)
  assert.equal(report.planAttribution.unknownRecords, 2)
  assert.equal(report.planAttribution.ambiguousRecords, 0)
  assert.deepEqual(report.planAttribution.dimensions.items, [{
    plan: "p", evidence: "exact-model-reference", records: 1, observedTokens: 2, unknownTokenRecords: 0,
    partialRecords: 0, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    unknownCacheRecords: 0, hostCostUSD: null, hostCostMissing: 1, cacheHitRate: null,
  }])
  assert.equal(report.errors.total, 1)
  assert.equal(report.errors.byClassification["rate-limit"].latestObservedAt, 1500)
  assert.equal(report.errors.complete, false)
  assert.equal(report.budgets[0].complete, false)
  assert.equal(report.budgets[0].remainingTokens, null)
  assert.equal(report.refresh, "reread")
  assert.equal(JSON.stringify(report).includes("project-b"), false)
  assert.equal(JSON.stringify(report).includes("event-a"), false)
})
