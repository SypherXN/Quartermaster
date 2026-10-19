import assert from "node:assert/strict"
import test from "node:test"
import { classifyRetryFailure, FailureCooldowns } from "../src/failures.ts"
import { modelKey, selectModel } from "../src/select.ts"
import type { ModelRef } from "../src/config.ts"

const primary: ModelRef = { providerID: "a", modelID: "primary" }
const spare: ModelRef = { providerID: "a", modelID: "spare" }
const otherProvider: ModelRef = { providerID: "b", modelID: "model" }
const registry = [primary, spare, otherProvider]
const eligible = new Map(registry.map((model) => [modelKey(model), { status: "available" as const }]))

test("structured retry failures permit only safe transient fallback", () => {
  const cases = [
    { error: { type: "provider.rate-limit", status: 429 }, fallback: true, classification: "temporary-rate-limit" },
    { error: { type: "provider.internal", status: 503 }, fallback: true, classification: "provider-outage" },
    { error: { type: "provider.transport", status: 503 }, fallback: true, classification: "provider-outage" },
    { error: { type: "provider.quota", status: 402 }, fallback: false, classification: "quota-exhausted" },
    { error: { type: "provider.auth", status: 401 }, fallback: false, classification: "auth" },
    { error: { type: "permission.rejected" }, fallback: false, classification: "auth" },
    { error: { type: "provider.invalid-request", status: 404 }, fallback: false, classification: "model-outage" },
    { error: { type: "provider.no-route" }, fallback: false, classification: "model-outage" },
    { error: { type: "provider.invalid-request", status: 413 }, fallback: false },
    { error: { type: "provider.content-filter" }, fallback: false },
    { error: { type: "provider.unsupported-operation" }, fallback: false },
    { error: { type: "provider.invalid-output" }, fallback: false },
    { error: { type: "provider.timeout" }, fallback: false },
    { error: { type: "provider.unknown" }, fallback: false },
    { error: { type: "cancelled" }, fallback: false },
    { error: { type: "provider.unknown", status: 503 }, fallback: false },
    { error: { type: "unrecognized" }, fallback: false },
    { error: { type: "unknown", message: "Rate limit exceeded. Please try again later." }, fallback: true, classification: "temporary-rate-limit" },
    { error: { message: "Too many requests" }, fallback: true, classification: "temporary-rate-limit" },
    { error: { response: { body: "429 rate_limit_exceeded" } }, fallback: true, classification: "temporary-rate-limit" },
    { error: { type: "provider.quota", status: 402, message: "rate limit exceeded" }, fallback: false, classification: "quota-exhausted" },
    { error: { type: "unknown", message: "Something else went wrong" }, fallback: false },
  ] as const

  for (const item of cases) {
    const label = "type" in item.error ? item.error.type : JSON.stringify(item.error)
    const result = classifyRetryFailure(item.error, "provider-a", "primary")
    assert.equal(result.fallback, item.fallback, label)
    assert.equal(result.report?.classification, "classification" in item ? item.classification : undefined, label)
    if (result.report) {
      assert.equal(result.report.providerID, "provider-a")
      if ("modelID" in result.report) assert.equal(result.report.modelID, "primary")
    }
  }
})

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

test("rate limits and attributed quota are model-scoped; unsafe failures are ignored", () => {
  const failures = new FailureCooldowns(100)
  for (const classification of ["quota-exhausted", "auth", "cancelled", "other"] as const) {
    assert.equal(failures.reportFailure({ providerID: "a", classification }, 0), false)
  }
  assert.equal(failures.reportFailure({ providerID: "a", modelID: "primary", classification: "temporary-rate-limit" }, 0), true)
  const result = failures.apply(eligible, registry, 1)
  assert.equal(result.get(modelKey(primary))?.cooldownUntil, 100)
  assert.equal(result.get(modelKey(spare))?.cooldownUntil, undefined)
  const quota = new FailureCooldowns(100)
  quota.reportFailure({ providerID: "a", modelID: "primary", classification: "quota-exhausted" }, 10)
  quota.reportFailure({ providerID: "a", modelID: "primary", classification: "quota-exhausted" }, 10)
  const restarted = new FailureCooldowns(100)
  restarted.restore(quota.snapshot(20, true), 20)
  assert.deepEqual(restarted.snapshot(20, true), [
    { providerID: "a", modelID: "primary", until: 110, occurredAt: 10, classification: "quota-exhausted" },
  ])
  assert.equal(restarted.reportFailure({ providerID: "a", modelID: "primary", classification: "quota-exhausted" }, 10), false)
  assert.deepEqual(restarted.snapshot(20), quota.snapshot(20))
  assert.equal(restarted.apply(eligible, registry, 109).get(modelKey(primary))?.cooldownUntil, 110)
  assert.equal(restarted.apply(eligible, registry, 109).get(modelKey(spare))?.cooldownUntil, undefined)
  assert.equal(restarted.apply(eligible, registry, 110).get(modelKey(primary))?.cooldownUntil, undefined)
})

test("a temporary rate limit cools every model in its shared group", () => {
  const grouped = new FailureCooldowns(100, [[primary, spare, otherProvider]])
  assert.equal(grouped.reportFailure({
    providerID: "a", modelID: "primary", classification: "temporary-rate-limit",
  }, 0), true)
  const limited = grouped.apply(eligible, registry, 1)
  assert.equal(limited.get(modelKey(primary))?.cooldownUntil, 100)
  assert.equal(limited.get(modelKey(spare))?.cooldownUntil, 100)
  assert.equal(limited.get(modelKey(otherProvider))?.cooldownUntil, 100)
  assert.equal(grouped.reportSuccess({ providerID: "a", scope: "model", modelID: "primary" }), true)
  const afterSuccess = grouped.apply(eligible, registry, 1)
  assert.equal(afterSuccess.get(modelKey(primary))?.cooldownUntil, undefined)
  assert.equal(afterSuccess.get(modelKey(spare))?.cooldownUntil, 100)

  const quota = new FailureCooldowns(100, [[primary, spare]])
  quota.reportFailure({ providerID: "a", modelID: "primary", classification: "quota-exhausted" }, 0)
  assert.equal(quota.apply(eligible, registry, 1).get(modelKey(primary))?.cooldownUntil, 100)
  assert.equal(quota.apply(eligible, registry, 1).get(modelKey(spare))?.cooldownUntil, 100)
  const ungrouped = new FailureCooldowns(100)
  ungrouped.reportFailure({ providerID: "a", modelID: "primary", classification: "quota-exhausted" }, 0)
  assert.equal(ungrouped.apply(eligible, registry, 1).get(modelKey(spare))?.cooldownUntil, undefined)
  const outage = new FailureCooldowns(100, [[primary, otherProvider]])
  outage.reportFailure({ providerID: "a", classification: "provider-outage" }, 0)
  assert.equal(outage.apply(eligible, registry, 1).get(modelKey(spare))?.cooldownUntil, 100)
  assert.equal(outage.apply(eligible, registry, 1).get(modelKey(otherProvider))?.cooldownUntil, undefined)
  const removed = new FailureCooldowns(100, [[primary, spare]])
  removed.setGroups([])
  removed.reportFailure({ providerID: "a", modelID: "primary", classification: "temporary-rate-limit" }, 0)
  assert.equal(removed.apply(eligible, registry, 1).get(modelKey(spare))?.cooldownUntil, undefined)
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
