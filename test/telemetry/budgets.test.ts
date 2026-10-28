import assert from "node:assert/strict"
import test from "node:test"
import type { TokenRateConfig } from "../../src/config.ts"
import { evaluateTokenBudgets } from "../../src/telemetry/budgets.ts"
import type { TokenTelemetryRecord } from "../../src/telemetry/types.ts"

const usdRate = (overrides: Partial<TokenRateConfig> = {}): TokenRateConfig => ({
  providerID: "provider-a",
  modelID: "model-a",
  inputPerMillion: 1_000_000,
  outputPerMillion: 0,
  currency: "USD",
  source: "test",
  asOf: 0,
  ...overrides,
})

const baseRecord = (overrides: Partial<TokenTelemetryRecord> = {}): TokenTelemetryRecord => ({
  hostContractVersion: "2.0.18",
  hostEventID: "event",
  sourceEvent: "session.step.ended",
  hostSessionID: "session",
  hostMessageID: "message",
  hostProjectID: "project-a",
  parentSessionID: null,
  hostAgentID: null,
  providerID: "provider-a",
  modelID: "model-a",
  variant: null,
  completedAt: 9_500,
  counts: { input: 10, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 4 },
  usageStatus: "reported",
  ...overrides,
  partial: overrides.partial ?? false,
})

test("no configured budgets produce no readings", () => {
  assert.deepEqual(evaluateTokenBudgets(undefined, [baseRecord()], 10_000, "project-a"), [])
  assert.deepEqual(evaluateTokenBudgets([], [baseRecord()], 10_000, "project-a"), [])
})

test("fixed rolling windows reset and overlapping dimensions stay independent", () => {
  const budgets = [
    { id: "project", dimension: "project" as const, limitTokens: 100, windowMs: 1_000 },
    { id: "model", dimension: "model" as const, target: "provider-a/model-a", limitTokens: 50, windowMs: 3_000 },
  ]
  const records = [
    baseRecord({ hostEventID: "a", completedAt: 9_500 }),
    baseRecord({ hostEventID: "b", modelID: "model-b", completedAt: 9_500 }),
    baseRecord({ hostEventID: "old", completedAt: 8_000 }),
    baseRecord({ hostEventID: "other-project", hostProjectID: "project-b" }),
  ]

  const current = evaluateTokenBudgets(budgets, records, 10_000, "project-a")
  assert.deepEqual(current.map(({ observedTokens, limitReached }) => ({ observedTokens, limitReached })), [
    { observedTokens: 30, limitReached: false },
    { observedTokens: 45, limitReached: false },
  ])

  const later = evaluateTokenBudgets(budgets, records, 12_501, "project-a")
  assert.deepEqual(later.map(({ observedTokens }) => observedTokens), [0, 0])
})

test("unknown dimensions and missing counts never imply remaining capacity", () => {
  const budgets = [
    { id: "project", dimension: "project" as const, limitTokens: 100, windowMs: 10_000 },
    { id: "provider", dimension: "provider" as const, target: "provider-a", limitTokens: 100, windowMs: 10_000 },
    { id: "plugin", dimension: "plugin" as const, target: "consumer", limitTokens: 100, windowMs: 10_000 },
  ]
  const records = [
    baseRecord({ hostEventID: "known" }),
    baseRecord({ hostEventID: "missing-counts", counts: null, usageStatus: "missing" }),
    baseRecord({ hostEventID: "unknown-owner", hostProjectID: null, providerID: null, modelID: null }),
  ]
  const readings = evaluateTokenBudgets(budgets, records, 10_000, "project-a")

  assert.deepEqual(readings.map(({ observedTokens, unknownRecords, limitReached }) => ({
    observedTokens,
    unknownRecords,
    limitReached,
  })), [
    { observedTokens: 15, unknownRecords: 2, limitReached: false },
    { observedTokens: 15, unknownRecords: 2, limitReached: false },
    { observedTokens: 0, unknownRecords: 3, limitReached: false },
  ])
  for (const reading of readings) {
    assert.equal(reading.complete, false)
    assert.equal(reading.remainingTokens, null)
  }
})

test("observed usage can prove a limit was reached", () => {
  const [reading] = evaluateTokenBudgets(
    [{ id: "project", dimension: "project", limitTokens: 15, windowMs: 1_000 }],
    [baseRecord()],
    10_000,
    "project-a",
  )
  assert.equal(reading.observedTokens, 15)
  assert.equal(reading.limitReached, true)
})

test("invalid token counts remain unknown instead of reducing usage", () => {
  const [reading] = evaluateTokenBudgets(
    [{ id: "project", dimension: "project", limitTokens: 100, windowMs: 1_000 }],
    [
      baseRecord({ counts: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }),
      baseRecord({ hostEventID: "negative", counts: { input: -100, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }),
      baseRecord({ hostEventID: "fractional", counts: { input: 1.5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }),
    ],
    10_000,
    "project-a",
  )
  assert.equal(reading.observedTokens, 15)
  assert.equal(reading.unknownRecords, 2)
})

test("calendar windows reset at timezone-aware month and week boundaries", () => {
  const monthNow = Date.parse("2024-04-15T12:00:00Z")
  const [month] = evaluateTokenBudgets(
    [{
      id: "month",
      dimension: "project",
      limitTokens: 100,
      calendarWindow: { unit: "month", timeZone: "UTC" },
    }],
    [
      baseRecord({ hostEventID: "march", completedAt: Date.parse("2024-03-31T23:59:59.999Z") }),
      baseRecord({ hostEventID: "april", completedAt: Date.parse("2024-04-01T00:00:00Z") }),
    ],
    monthNow,
    "project-a",
  )
  assert.equal(month.windowStart, Date.parse("2024-04-01T00:00:00Z"))
  assert.equal(month.observedTokens, 15)

  const weekNow = Date.parse("2024-04-10T12:00:00Z")
  const [week] = evaluateTokenBudgets(
    [{
      id: "week",
      dimension: "project",
      limitTokens: 100,
      calendarWindow: { unit: "week", timeZone: "UTC" },
    }],
    [
      baseRecord({ hostEventID: "sunday", completedAt: Date.parse("2024-04-07T23:59:59.999Z") }),
      baseRecord({ hostEventID: "monday", completedAt: Date.parse("2024-04-08T00:00:00Z") }),
    ],
    weekNow,
    "project-a",
  )
  assert.equal(week.windowStart, Date.parse("2024-04-08T00:00:00Z"))
  assert.equal(week.observedTokens, 15)
})

test("calendar day window uses local midnight across daylight-saving change", () => {
  const now = Date.parse("2024-03-10T16:00:00Z")
  const [reading] = evaluateTokenBudgets(
    [{
      id: "new-york-day",
      dimension: "project",
      limitTokens: 100,
      calendarWindow: { unit: "day", timeZone: "America/New_York" },
    }],
    [
      baseRecord({ hostEventID: "before-midnight", completedAt: Date.parse("2024-03-10T04:59:59.999Z") }),
      baseRecord({ hostEventID: "at-midnight", completedAt: Date.parse("2024-03-10T05:00:00Z") }),
    ],
    now,
    "project-a",
  )
  assert.equal(reading.windowStart, Date.parse("2024-03-10T05:00:00Z"))
  assert.equal(reading.observedTokens, 15)
})

test("USD cap reached and not reached from priced window usage", () => {
  const budgets = [{ id: "project", dimension: "project" as const, limitUSD: 9.5, windowMs: 10_000 }]
  const pricing = { rates: [usdRate()] }
  const records = [baseRecord()]

  const [belowCap] = evaluateTokenBudgets(
    [{ ...budgets[0], limitUSD: 10.5 }],
    records,
    10_000,
    "project-a",
    pricing,
  )
  assert.equal(belowCap.usedUSD, 10)
  assert.equal(belowCap.costUnknown, false)
  assert.equal(belowCap.costComplete, true)
  assert.equal(belowCap.limitReached, false)
  assert.equal(belowCap.remainingUSD, 0.5)

  const [atCap] = evaluateTokenBudgets(budgets, records, 10_000, "project-a", pricing)
  assert.equal(atCap.usedUSD, 10)
  assert.equal(atCap.limitReached, true)
  assert.equal(atCap.remainingUSD, 0)
})

test("mixed-currency windows leave usedUSD null and costUnknown", () => {
  const pricing = {
    rates: [
      usdRate(),
      usdRate({ providerID: "provider-b", modelID: "model-b", currency: "EUR" }),
    ],
  }
  const [reading] = evaluateTokenBudgets(
    [{ id: "project", dimension: "project", limitUSD: 100, windowMs: 10_000 }],
    [
      baseRecord(),
      baseRecord({
        hostEventID: "eur",
        providerID: "provider-b",
        modelID: "model-b",
        counts: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ],
    10_000,
    "project-a",
    pricing,
  )
  assert.equal(reading.usedUSD, null)
  assert.equal(reading.costUnknown, true)
  assert.equal(reading.limitReached, false)
})
