import assert from "node:assert/strict"
import test from "node:test"
import { estimateTokenCosts } from "../../src/telemetry/costs.ts"
import { projectStepStart, StepModelClaims } from "../../src/telemetry/step-model.ts"
import type { TokenTelemetryRecord } from "../../src/telemetry/types.ts"
import { projectWindow } from "../../src/telemetry/window.ts"

const row = (id: string, hostCostUSD?: number): TokenTelemetryRecord => ({
  hostContractVersion: "2.0.18", hostEventID: id, sourceEvent: "session.step.ended",
  hostSessionID: `session-${id}`, hostMessageID: `message-${id}`, hostProjectID: "project",
  parentSessionID: null, hostAgentID: null, providerID: "provider-a", modelID: "model-a",
  variant: null, completedAt: 100, counts: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  usageStatus: "reported", partial: false, ...(hostCostUSD === undefined ? {} : { hostCostUSD }),
})

test("host-reported cost sums reported steps and counts the rest as missing", () => {
  const costs = estimateTokenCosts([row("a", 0.25), row("b"), row("c", 0.5)])
  assert.deepEqual(costs.hostReported, { currency: "USD", amount: 0.75, records: 2, missingRecords: 1 })
  // The host figure is reported beside the estimate, never folded into it.
  assert.equal(costs.unpricedRecords, 3)
  assert.deepEqual(costs.currencies, [])
})

test("a step's own start event names the model that ran it", () => {
  const claims = new StepModelClaims()
  claims.observe({ id: "start-1", type: "session.step.started", data: {
    assistantMessageID: "msg", model: { providerID: "provider-b", id: "model-b", variant: "high" },
  } })
  assert.deepEqual(claims.claim("end-1", "msg"), { providerID: "provider-b", modelID: "model-b", variant: "high" })
  // A repeat claim for the same terminal event is stable, not a second pairing.
  assert.equal(claims.claim("end-1", "msg")?.modelID, "model-b")
  // No start event for this step: the model stays unknown rather than guessed.
  assert.equal(claims.claim("end-2", "unstarted"), undefined)
  assert.equal(projectStepStart({ type: "session.step.ended", data: {} }), undefined)
})

test("window split counts context characters per bucket, not tokens", () => {
  const counts = projectWindow([
    { type: "user", text: "abcd" },
    { type: "assistant", content: [
      { type: "text", text: "ef" },
      { type: "reasoning", text: "ghi" },
      { type: "tool", state: { input: "jklm" } },
    ] },
  ])
  assert.deepEqual(counts, { user: 4, assistant: 2, tool: 4, other: 3 })
})
