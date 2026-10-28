import assert from "node:assert/strict"
import test from "node:test"
import type { TokenBudgetConfig, TokenRateConfig } from "../../src/config.ts"
import { TokenBudgetGate } from "../../src/telemetry/budget-gate.ts"
import type { TokenTelemetryRecord } from "../../src/telemetry/types.ts"

const usdRate: TokenRateConfig = {
  providerID: "provider-a",
  modelID: "model-a",
  inputPerMillion: 1_000_000,
  outputPerMillion: 0,
  currency: "USD",
  source: "test",
  asOf: 0,
}

const record = (overrides: Partial<TokenTelemetryRecord> = {}): TokenTelemetryRecord => ({
  hostContractVersion: "2.0.18",
  hostEventID: "event",
  sourceEvent: "session.step.ended",
  hostSessionID: "session",
  hostMessageID: "message",
  hostProjectID: "project-a",
  parentSessionID: null,
  hostAgentID: null,
  providerID: null,
  modelID: null,
  variant: null,
  completedAt: 9_500,
  counts: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  usageStatus: "reported",
  ...overrides,
  partial: overrides.partial ?? false,
})

const budget = (overrides: Partial<TokenBudgetConfig> = {}): TokenBudgetConfig => ({
  id: "project-day",
  dimension: "project",
  mode: "advisory",
  limitTokens: 15,
  windowMs: 1_000,
  ...overrides,
})

test("advisory budgets report reached limits and unknown usage at a fixed time", () => {
  const gate = new TokenBudgetGate(
    [budget()],
    "project-a",
    [record(), record({ hostEventID: "unknown", counts: null, usageStatus: "missing" })],
  )

  assert.deepEqual(gate.reasons(10_000).map(({ code, observedTokens, unknownRecords }) => ({
    code,
    observedTokens,
    unknownRecords,
  })), [
    { code: "budget-limit-reached", observedTokens: 15, unknownRecords: 1 },
    { code: "budget-usage-unknown", observedTokens: 15, unknownRecords: 1 },
  ])
})

test("strict budgets report unsupported enforcement without claiming or applying a cap", () => {
  const gate = new TokenBudgetGate([budget({ mode: "strict", limitTokens: 100 })], "project-a", [record()])
  const first = gate.reasons(10_000)
  const second = gate.reasons(10_000)

  assert.deepEqual(first, second)
  assert.equal(first.length, 1)
  assert.equal(first[0].code, "cannot-guarantee-hard-cap")
  assert.equal(first[0].observedTokens, 15)
  assert.equal(first[0].remainingTokens, null)
  assert.equal(first[0].complete, false)
})

test("below-limit known usage and disabled budgets produce no warnings", () => {
  assert.deepEqual(
    new TokenBudgetGate([budget({ limitTokens: 100 })], "project-a", [record()]).reasons(10_000),
    [],
  )
  assert.deepEqual(new TokenBudgetGate(undefined, "project-a", [record()]).reasons(10_000), [])
})

test("USD budgets emit cost reached and cost unknown reasons", () => {
  const pricing = { rates: [usdRate] }
  const reached = new TokenBudgetGate(
    [budget({ limitTokens: undefined, limitUSD: 9.5 })],
    "project-a",
    [record({ providerID: "provider-a", modelID: "model-a" })],
    pricing,
  )
  assert.deepEqual(reached.reasons(10_000).map(({ code }) => code), ["budget-cost-reached"])

  const unknown = new TokenBudgetGate(
    [budget({ limitTokens: undefined, limitUSD: 100 })],
    "project-a",
    [record({ providerID: "provider-a", modelID: "model-a", counts: null, usageStatus: "missing" })],
    pricing,
  )
  assert.deepEqual(unknown.reasons(10_000).map(({ code }) => code), [
    "budget-cost-unknown",
    "budget-usage-unknown",
  ])
})
