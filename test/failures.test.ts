import assert from "node:assert/strict"
import test from "node:test"
import { FailureCooldowns } from "../src/failures.ts"
import { modelKey, selectModel } from "../src/select.ts"
import type { ModelRef } from "../src/config.ts"

const primary: ModelRef = { providerID: "a", modelID: "primary" }
const spare: ModelRef = { providerID: "a", modelID: "spare" }
const otherProvider: ModelRef = { providerID: "b", modelID: "model" }
const registry = [primary, spare, otherProvider]
const eligible = new Map(registry.map((model) => [modelKey(model), { status: "available" as const }]))

test("model and provider outages affect only their scopes", () => {
  const failures = new FailureCooldowns(100)
  failures.reportFailure({ providerID: "a", modelID: "primary", classification: "model-outage" }, 0)

  const modelScoped = selectModel(
    registry,
    registry,
    failures.apply(eligible, registry, 1),
    1,
  )
  assert.equal(modelScoped.status, "selected")
  if (modelScoped.status === "selected") {
    assert.equal(modelScoped.model, spare)
    assert.deepEqual(modelScoped.skipped, [{ model: primary, reason: { code: "cooldown" } }])
  }

  failures.reportFailure({ providerID: "a", classification: "provider-outage" }, 2)
  const providerScoped = selectModel(
    [primary, spare, otherProvider],
    registry,
    failures.apply(eligible, registry, 3),
    3,
  )
  assert.equal(providerScoped.status, "selected")
  if (providerScoped.status === "selected") {
    assert.equal(providerScoped.model, otherProvider)
    assert.deepEqual(providerScoped.skipped.map((item) => item.reason.code), ["cooldown", "cooldown"])
  }
})

test("temporary rate limits are scoped while quota, auth, cancellation, and generic errors are ignored", () => {
  const failures = new FailureCooldowns(100)
  for (const classification of ["quota-exhausted", "auth", "cancelled", "other"] as const) {
    assert.equal(failures.reportFailure({ providerID: "a", classification }, 0), false)
  }
  assert.equal(failures.reportFailure({ providerID: "a", modelID: "primary", classification: "temporary-rate-limit" }, 0), true)
  const result = failures.apply(eligible, registry, 1)
  assert.equal(result.get(modelKey(primary))?.cooldownUntil, 100)
  assert.equal(result.get(modelKey(spare))?.cooldownUntil, undefined)
})

test("repeated reports extend but never shorten cooldown; expiry is exact", () => {
  const failures = new FailureCooldowns(100)
  failures.reportFailure({ providerID: "a", classification: "provider-outage" }, 10)
  failures.reportFailure({ providerID: "a", classification: "provider-outage" }, 50)
  failures.reportFailure({ providerID: "a", classification: "provider-outage" }, 20)

  assert.equal(failures.apply(eligible, registry, 149).get(modelKey(primary))?.cooldownUntil, 150)
  assert.equal(failures.apply(eligible, registry, 150).get(modelKey(primary))?.cooldownUntil, undefined)
})

test("success clears its exact scope, and persisted cooldowns restore only while active", () => {
  const failures = new FailureCooldowns(100)
  failures.reportFailure({ providerID: "a", classification: "provider-outage" }, 0)
  failures.reportFailure({ providerID: "a", modelID: "primary", classification: "model-outage" }, 0)
  assert.equal(failures.reportSuccess({ providerID: "a", scope: "model", modelID: "primary" }), true)
  assert.equal(failures.apply(eligible, registry, 1).get(modelKey(primary))?.cooldownUntil, 100)
  assert.equal(failures.reportSuccess({ providerID: "a", scope: "provider" }), true)
  assert.equal(failures.apply(eligible, registry, 1).get(modelKey(primary))?.cooldownUntil, undefined)

  const restarted = new FailureCooldowns(100)
  assert.equal(restarted.apply(eligible, registry, 1).get(modelKey(primary))?.cooldownUntil, undefined)

  const active = new FailureCooldowns(100)
  active.restore({ cooldowns: [
    { providerID: "a", modelID: "primary", until: 20 },
    { providerID: "a", until: 20 },
    { providerID: "b", until: 0 },
    { providerID: "", until: 20 },
    null,
  ] }, 10)
  assert.equal(active.apply(eligible, registry, 11).get(modelKey(primary))?.cooldownUntil, 20)
  assert.equal(active.apply(eligible, registry, 20).get(modelKey(primary))?.cooldownUntil, undefined)

  const expired = new FailureCooldowns(100)
  expired.restore([{ providerID: "a", until: 10 }], 10)
  assert.equal(expired.apply(eligible, registry, 10).get(modelKey(primary))?.cooldownUntil, undefined)
})
