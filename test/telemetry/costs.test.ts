import assert from "node:assert/strict"
import test from "node:test"
import { estimateTokenCosts } from "../../src/telemetry/costs.ts"
import type { TokenTelemetryRecord } from "../../src/telemetry/types.ts"

const row = (id: string, modelID: string | null, variant: string | null, counts: TokenTelemetryRecord["counts"]): TokenTelemetryRecord => ({
  hostContractVersion: "2.0.18", hostEventID: id, sourceEvent: "session.step.ended",
  hostSessionID: `session-${id}`, hostMessageID: `message-${id}`, hostProjectID: "project",
  parentSessionID: null, hostAgentID: null, providerID: modelID ? "provider-a" : null,
  modelID, variant, completedAt: 100, counts, usageStatus: counts ? "reported" : "missing",
})

const counts = (input: number) => ({ input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })

for (const overflowAmount of [false, true]) {
  test(`unpriced token accumulation stays safe with ${overflowAmount ? "overflowing amounts" : "missing rates"}`, () => {
    const rows = [
      row("large", "model-a", null, counts(Number.MAX_SAFE_INTEGER)),
      row("one", "model-a", null, counts(overflowAmount ? 2 : 1)),
      row("two", "model-a", null, counts(overflowAmount ? 2 : 1)),
    ]
    const costs = estimateTokenCosts(rows, overflowAmount ? [{
      providerID: "provider-a", modelID: "model-a", inputPerMillion: Number.MAX_VALUE,
      outputPerMillion: 0, currency: "USD", source: "overflow fixture", asOf: 100,
    }] : [])
    assert.equal(costs.unpricedTokens, Number.MAX_SAFE_INTEGER)
    assert.equal(costs.unknownTokenRecords, 2)
    assert.equal(costs.pricedRecords + costs.unpricedRecords, rows.length)
    assert.ok(Number.isSafeInteger(costs.unpricedTokens))
    assert.equal(costs.complete, false)
  })
}

test("priced token accumulation stays safe across separate currencies", () => {
  const costs = estimateTokenCosts([
    row("large", "model-a", null, counts(Number.MAX_SAFE_INTEGER)),
    row("one", "model-b", null, counts(1)),
    row("two", "model-b", null, counts(1)),
  ], [
    { providerID: "provider-a", modelID: "model-a", inputPerMillion: 1, outputPerMillion: 0, currency: "USD", source: "fixture", asOf: 100 },
    { providerID: "provider-a", modelID: "model-b", inputPerMillion: 1, outputPerMillion: 0, currency: "EUR", source: "fixture", asOf: 100 },
  ])
  assert.equal(costs.pricedTokens, Number.MAX_SAFE_INTEGER)
  assert.equal(costs.pricedRecords, 1)
  assert.equal(costs.unpricedTokens, 2)
  assert.equal(costs.unpricedRecords, 2)
  assert.equal(costs.unknownTokenRecords, 0)
  assert.deepEqual(costs.currencies.map(({ currency, pricedTokens }) => ({ currency, pricedTokens })), [
    { currency: "USD", pricedTokens: Number.MAX_SAFE_INTEGER },
  ])
})

test("revised rates reprice the same records and keep the new asOf", () => {
  const records = [row("priced", "model-a", null, counts(1_000_000))]
  const rate = (inputPerMillion: number, asOf: number) => ({
    providerID: "provider-a", modelID: "model-a", inputPerMillion, outputPerMillion: 0,
    currency: "USD", source: "revised card", asOf,
  })
  const first = estimateTokenCosts(records, [rate(1, 100)])
  const second = estimateTokenCosts(records, [rate(2, 200)])
  assert.equal(first.currencies[0]?.estimatedAmount, 1)
  assert.equal(first.currencies[0]?.rates[0]?.asOf, 100)
  assert.equal(second.currencies[0]?.estimatedAmount, 2)
  assert.equal(second.currencies[0]?.rates[0]?.asOf, 200)
  assert.equal(second.pricedRecords, 1)
  assert.equal(second.complete, false)
})

test("estimated costs require an exact model variant and separate currencies", () => {
  const rows = [
    row("priced", "model-a", "fast", { input: 1_000_000, output: 2_000_000, reasoning: 2_000_000, cacheRead: 3_000_000, cacheWrite: 0 }),
    row("wrong-variant", "model-a", "slow", { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 }),
    row("missing-model", null, null, { input: 4, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 }),
    row("missing-counts", "model-a", "fast", null),
    row("other-currency", "model-b", null, { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }),
  ]
  const costs = estimateTokenCosts(rows, [
    { providerID: "provider-a", modelID: "model-a", variant: "fast", inputPerMillion: 2, outputPerMillion: 4, currency: "USD", source: "rate card v2", asOf: 200 },
    { providerID: "provider-a", modelID: "model-b", inputPerMillion: 1, outputPerMillion: 0, currency: "EUR", source: "rate card", asOf: 150 },
  ])

  assert.equal(costs.status, "estimated-not-billed")
  assert.equal(costs.complete, false)
  assert.equal(costs.pricedRecords, 2)
  assert.equal(costs.pricedTokens, 4_000_000)
  assert.equal(costs.unpricedRecords, 3)
  assert.equal(costs.unpricedTokens, 22)
  assert.equal(costs.unknownTokenRecords, 1)
  assert.deepEqual(costs.currencies.map(({ currency, estimatedAmount, rates }) => ({ currency, estimatedAmount, rates })), [
    { currency: "EUR", estimatedAmount: 1, rates: [{ providerID: "provider-a", modelID: "model-b", inputPerMillion: 1, outputPerMillion: 0, currency: "EUR", source: "rate card", asOf: 150 }] },
    { currency: "USD", estimatedAmount: 10, rates: [{ providerID: "provider-a", modelID: "model-a", variant: "fast", inputPerMillion: 2, outputPerMillion: 4, currency: "USD", source: "rate card v2", asOf: 200 }] },
  ])
})
