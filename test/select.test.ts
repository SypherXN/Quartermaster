import assert from "node:assert/strict"
import test from "node:test"
import { modelKey, selectAgentModel, selectModel } from "../src/select.ts"
import type { ModelEligibility } from "../src/select.ts"
import type { ModelRef } from "../src/config.ts"

const primary: ModelRef = { providerID: "a", modelID: "main", variant: "fast" }
const backup: ModelRef = { providerID: "b", modelID: "backup", variant: "balanced" }
const unknown: ModelRef = { providerID: "c", modelID: "unknown" }
const missingStatus: ModelRef = { providerID: "d", modelID: "missing" }
const registry = [primary, backup, unknown, missingStatus]

test("selects the first eligible registry model and preserves its variant", () => {
  const result = selectModel(
    [primary, backup],
    registry,
    new Map<string, ModelEligibility>([
      [modelKey(primary), { status: "limited" }],
      [modelKey(backup), { status: "available" }],
    ]),
    100,
  )

  assert.deepEqual(result, {
    status: "selected",
    model: backup,
    reason: { code: "highest-priority-eligible" },
    skipped: [{ model: primary, reason: { code: "limited" } }],
  })
})

test("a recovered primary wins the next selection", () => {
  const plan = [primary, backup]
  const snapshot = new Map<string, ModelEligibility>([
    [modelKey(primary), { status: "limited" }],
    [modelKey(backup), { status: "available" }],
  ])
  assert.equal(selectModel(plan, registry, snapshot, 100).status, "selected")

  snapshot.set(modelKey(primary), { status: "available" })
  const recovered = selectModel(plan, registry, snapshot, 101)
  assert.equal(recovered.status, "selected")
  if (recovered.status === "selected") assert.equal(recovered.model, primary)
})

test("unknown, missing, and stale statuses never become eligible", () => {
  const notRegistered: ModelRef = { providerID: "e", modelID: "absent" }
  const result = selectModel(
    [primary, unknown, missingStatus, notRegistered],
    registry,
    new Map<string, ModelEligibility>([
      [modelKey(primary), { status: "available", staleAt: 100 }],
      [modelKey(unknown), { status: "unknown" }],
    ]),
    100,
  )

  assert.deepEqual(result, {
    status: "no-eligible",
    reason: { code: "no-eligible" },
    skipped: [
      { model: primary, reason: { code: "stale" } },
      { model: unknown, reason: { code: "unknown" } },
      { model: missingStatus, reason: { code: "status-missing" } },
      { model: notRegistered, reason: { code: "not-in-registry" } },
    ],
  })

  const fallback = selectModel(
    [primary, backup],
    registry,
    new Map<string, ModelEligibility>([
      [modelKey(primary), { status: "unknown" }],
      [modelKey(backup), { status: "available" }],
    ]),
    100,
  )
  assert.equal(fallback.status, "selected")
  if (fallback.status === "selected") {
    assert.equal(fallback.model, backup)
    assert.deepEqual(fallback.skipped, [{ model: primary, reason: { code: "unknown" } }])
  }
})

test("reports no plan and no eligible candidates explicitly", () => {
  assert.deepEqual(selectModel(undefined, registry, new Map(), 100), {
    status: "no-plan",
    reason: { code: "no-plan" },
    skipped: [],
  })
  assert.deepEqual(selectModel([primary], registry, new Map(), 100), {
    status: "no-eligible",
    reason: { code: "no-eligible" },
    skipped: [{ model: primary, reason: { code: "status-missing" } }],
  })
})

test("a busy exclusive model is skipped, including a pin, unless this agent holds it", () => {
  const eligible = new Map<string, ModelEligibility>([
    [modelKey(primary), { status: "available" }],
    [modelKey(backup), { status: "available" }],
  ])
  const busy = (model: ModelRef) => model.modelID === primary.modelID
  const skipped = selectModel([primary, backup], registry, eligible, 100, busy)
  assert.equal(skipped.status, "selected")
  if (skipped.status === "selected") {
    assert.equal(skipped.model, backup)
    assert.deepEqual(skipped.skipped, [{ model: primary, reason: { code: "exclusive-busy" } }])
  }
  const open = selectModel([primary, backup], registry, eligible, 100)
  assert.equal(open.status, "selected")
  if (open.status === "selected") assert.equal(open.model, primary)

  const config = { plans: { review: [primary, backup] }, agents: { reviewer: "review", builder: "review" } }
  const held = selectAgentModel(config, "reviewer", registry, eligible, 100, primary, () => false)
  assert.equal(held.status, "selected")
  if (held.status === "selected") assert.equal(held.reason.code, "manual-pin")
  const pinned = selectAgentModel(config, "builder", registry, eligible, 100, primary, busy)
  assert.equal(pinned.status, "selected")
  if (pinned.status === "selected") {
    assert.equal(pinned.model, backup)
    assert.equal(pinned.skipped[0]?.reason.code, "exclusive-busy")
  }
})
