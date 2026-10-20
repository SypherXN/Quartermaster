import assert from "node:assert/strict"
import test from "node:test"
import { classifyRetryFailure, FailureCooldowns } from "../src/failures.ts"
import { modelKey } from "../src/select.ts"
import {
  bucketId, bucketMembers, probeBackoffMs, RateLimitProbes, selectProbeTargets,
} from "../src/rate-limit-probe.ts"
import type { ModelRef } from "../src/config.ts"

const primary: ModelRef = { providerID: "opencode", modelID: "primary-free" }
const sibling: ModelRef = { providerID: "opencode", modelID: "sibling-free" }
const outsider: ModelRef = { providerID: "opencode", modelID: "outsider-free" }
const groups = [[primary, sibling]]

/** The shipped defaults: a five minute base interval and a one hour cap. */
const intervalMs = 300_000
const maxBackoffMs = 3_600_000

const cooldowns = (entries: { model: ModelRef; until: number }[]) =>
  new Map(entries.map((entry) => [modelKey(entry.model), entry.until]))

const eligible = new Map([primary, sibling, outsider].map((model) => [modelKey(model), { status: "available" as const }]))

test("a bucket is only probed after its own cooldown floor expired", () => {
  const models = [primary]
  const limited = cooldowns([{ model: primary, until: 1_000 }])
  assert.deepEqual(selectProbeTargets({ now: 999, models, groups, cooldowns: limited, intervalMs, maxBackoffMs }), [])
  assert.deepEqual(
    selectProbeTargets({ now: 1_000, models, groups, cooldowns: limited, intervalMs, maxBackoffMs }).map((model) => model.modelID),
    ["primary-free"],
  )
})

test("a model that is not rate limited is never probed", () => {
  assert.deepEqual(
    selectProbeTargets({ now: 10_000, models: [primary], groups, cooldowns: cooldowns([]), intervalMs, maxBackoffMs }),
    [],
  )
})

test("a provider-stated reset in the future suppresses the probe", () => {
  const models = [primary]
  const limited = cooldowns([{ model: primary, until: 1_000 }])
  const deadlines = new Map([[modelKey(primary), 5_000]])
  assert.deepEqual(selectProbeTargets({ now: 2_000, models, groups, cooldowns: limited, deadlines, intervalMs, maxBackoffMs }), [])
  assert.equal(
    selectProbeTargets({ now: 5_000, models, groups, cooldowns: limited, deadlines, intervalMs, maxBackoffMs }).length,
    1,
  )
})

test("only one probe per shared bucket is selected", () => {
  const models = [primary, sibling, outsider]
  const limited = cooldowns([
    { model: primary, until: 1_000 },
    { model: sibling, until: 1_000 },
    { model: outsider, until: 1_000 },
  ])
  const targets = selectProbeTargets({ now: 2_000, models, groups, cooldowns: limited, intervalMs, maxBackoffMs })
  assert.deepEqual(targets.map((model) => model.modelID), ["primary-free", "outsider-free"])
  assert.deepEqual(bucketMembers(primary, groups), [primary, sibling])
  assert.deepEqual(bucketMembers(outsider, groups), [outsider])
  assert.notEqual(bucketId(primary, groups), bucketId(outsider, groups))
})

test("the backoff doubles per failed probe and is capped", () => {
  assert.equal(probeBackoffMs(300_000, 0, 3_600_000), 300_000)
  assert.equal(probeBackoffMs(300_000, 1, 3_600_000), 600_000)
  assert.equal(probeBackoffMs(300_000, 2, 3_600_000), 1_200_000)
  assert.equal(probeBackoffMs(300_000, 3, 3_600_000), 2_400_000)
  assert.equal(probeBackoffMs(300_000, 4, 3_600_000), 3_600_000, "the doubling stops at the cap")
  assert.equal(probeBackoffMs(300_000, 20, 3_600_000), 3_600_000)

  const probes = new RateLimitProbes()
  const limited = cooldowns([{ model: primary, until: 1_000 }])
  const base = { now: 2_000, models: [primary], groups, cooldowns: limited, intervalMs, maxBackoffMs }
  assert.equal(probes.select(base).length, 1)
  probes.record(primary, "still-limited", 2_000, groups)
  assert.equal(probes.select({ ...base, now: 30_000 }).length, 0, "the first backoff window must hold")
  assert.equal(probes.select({ ...base, now: 2_000 + 600_000 - 1 }).length, 0, "one failed probe doubles the window")
  assert.equal(probes.select({ ...base, now: 2_000 + 600_000 }).length, 1)
  probes.record(primary, "still-limited", 2_000 + 600_000, groups)
  assert.equal(probes.select({ ...base, now: 2_000 + 600_000 + 1_200_000 - 1 }).length, 0, "the window must double again")
  assert.equal(probes.select({ ...base, now: 2_000 + 600_000 + 1_200_000 }).length, 1)
  probes.record(primary, "still-limited", 2_000 + 600_000 + 1_200_000, groups)
  // Three consecutive failures: the window doubles to 40 minutes.
  const at40 = 2_000 + 600_000 + 1_200_000 + 2_400_000
  assert.equal(probes.select({ ...base, now: at40 }).length, 1)
  probes.record(primary, "still-limited", at40, groups)
  // The next window would be 80 minutes, so the cap holds it at 60.
  assert.equal(probes.select({ ...base, now: at40 + 3_600_000 - 1 }).length, 0, "the window is capped at 60 minutes")
  assert.equal(probes.select({ ...base, now: at40 + 3_600_000 }).length, 1)
})

test("a smaller configured cap takes effect instead of the default", () => {
  assert.equal(probeBackoffMs(300_000, 1, 600_000), 600_000)
  assert.equal(probeBackoffMs(300_000, 4, 600_000), 600_000)

  const probes = new RateLimitProbes()
  const limited = cooldowns([{ model: primary, until: 1_000 }])
  const base = { now: 2_000, models: [primary], groups, cooldowns: limited, intervalMs, maxBackoffMs: 600_000 }
  assert.equal(probes.select(base).length, 1)
  probes.record(primary, "still-limited", 2_000, groups)
  assert.equal(probes.select({ ...base, now: 2_000 + 599_999 }).length, 0, "the configured cap holds the window")
  assert.equal(probes.select({ ...base, now: 2_000 + 600_000 }).length, 1)
  probes.record(primary, "still-limited", 2_000 + 600_000, groups)
  assert.equal(probes.select({ ...base, now: 2_000 + 600_000 + 599_999 }).length, 0, "the cap holds instead of doubling")
  assert.equal(probes.select({ ...base, now: 2_000 + 600_000 + 600_000 }).length, 1)
})

test("the backoff keeps polling while the provider floor is still running", () => {
  const probes = new RateLimitProbes()
  const limited = cooldowns([{ model: primary, until: 900_000 }])
  const base = { now: 2_000, models: [primary], groups, cooldowns: limited, intervalMs, maxBackoffMs }
  assert.equal(probes.select(base).length, 0, "the first probe waits for the provider floor")
  probes.record(primary, "still-limited", 2_000, groups)
  // The floor is still running, but the backoff alone drives the schedule from here on.
  assert.equal(probes.select({ ...base, now: 2_000 + 300_000 }).length, 0)
  assert.equal(probes.select({ ...base, now: 2_000 + 600_000 }).length, 1)
})

test("a probe never runs while a primary request is running", () => {
  const limited = cooldowns([{ model: primary, until: 1_000 }])
  assert.deepEqual(
    selectProbeTargets({ now: 2_000, models: [primary], groups, cooldowns: limited, intervalMs, maxBackoffMs, busy: true }),
    [],
  )
})

test("a successful probe resets the backoff of its bucket", () => {
  const probes = new RateLimitProbes()
  const limited = cooldowns([{ model: primary, until: 1_000 }])
  const base = { now: 2_000, models: [primary], groups, cooldowns: limited, intervalMs, maxBackoffMs }
  probes.record(primary, "still-limited", 2_000, groups)
  assert.equal(probes.select({ ...base, now: 2_000 + 30_000 }).length, 0)
  probes.record(primary, "success", 2_000 + 30_000, groups)
  assert.equal(probes.select({ ...base, now: 2_000 + 30_000 }).length, 1)
  assert.deepEqual(probes.snapshot().map((entry) => entry.outcome), ["still-limited", "success"])
})

test("a successful probe clears the model and its shared group, a limited probe keeps them out", () => {
  const failures = new FailureCooldowns(300_000, groups)
  failures.reportFailure({ providerID: "opencode", modelID: "primary-free", classification: "quota-exhausted" }, 0)
  assert.equal(failures.apply(eligible, [primary, sibling], 1).get(modelKey(sibling))?.cooldownUntil, 300_000)

  assert.equal(failures.clear("opencode", "primary-free"), true)
  const recovered = failures.apply(eligible, [primary, sibling], 1)
  assert.equal(recovered.get(modelKey(primary))?.cooldownUntil, undefined)
  assert.equal(recovered.get(modelKey(sibling))?.cooldownUntil, undefined)

  // A still-limited probe is fresh evidence: the provider cooldown stays the floor.
  const limited = new FailureCooldowns(300_000, groups)
  const failure = classifyRetryFailure({ type: "provider.rate-limit", status: 429 }, "opencode", "primary-free")
  assert.equal(failure.report?.classification, "temporary-rate-limit")
  assert.equal(limited.reportFailure(failure.report!, 1_000), true)
  const cooling = limited.apply(eligible, [primary, sibling], 1_001)
  assert.equal(cooling.get(modelKey(primary))?.cooldownUntil, 301_000)
  assert.equal(cooling.get(modelKey(sibling))?.cooldownUntil, 301_000, "the probe floor must spread to the shared bucket")
})

test("a probe never shortens the skip window below the configured provider cooldown", () => {
  const failures = new FailureCooldowns(300_000, groups)
  const failure = classifyRetryFailure({ type: "provider.rate-limit", status: 429 }, "opencode", "primary-free")
  // The probe reports the failure with the provider floor, not with the shorter probe interval.
  assert.equal(failures.reportFailure(failure.report!, 1_000), true)
  const cooling = failures.apply(eligible, [primary, sibling], 1_001)
  assert.equal(cooling.get(modelKey(primary))?.cooldownUntil, 301_000)
  assert.equal(cooling.get(modelKey(sibling))?.cooldownUntil, 301_000)
})

test("a successful probe keeps an outage cooldown of a group member", () => {
  const failures = new FailureCooldowns(300_000, groups)
  failures.reportFailure({ providerID: "opencode", modelID: "primary-free", classification: "quota-exhausted" }, 0)
  failures.reportFailure({ providerID: "opencode", modelID: "sibling-free", classification: "model-outage" }, 0)
  assert.equal(failures.clear("opencode", "primary-free"), true)
  const state = failures.apply(eligible, [primary, sibling], 1)
  assert.equal(state.get(modelKey(primary))?.cooldownUntil, undefined, "the bucket limit is gone")
  assert.equal(state.get(modelKey(sibling))?.cooldownUntil, 300_000, "the outage of that model stays")
})

test("a quota-shaped probe failure behaves like a rate-limit-shaped one", () => {
  for (const error of [
    { type: "provider.quota", status: 402 },
    { type: "unknown", message: "OpenCode Zen: Rate limit exceeded. Please try again later." },
  ]) {
    const failures = new FailureCooldowns(300_000, groups)
    const failure = classifyRetryFailure(error, "opencode", "primary-free")
    assert.ok(failure.report, JSON.stringify(error))
    assert.equal(failures.reportFailure(failure.report!, 1_000), true)
    const cooling = failures.apply(eligible, [primary, sibling], 1_001)
    assert.equal(cooling.get(modelKey(primary))?.cooldownUntil, 301_000, JSON.stringify(error))
    assert.equal(cooling.get(modelKey(sibling))?.cooldownUntil, 301_000, JSON.stringify(error))
    assert.equal(failures.clear("opencode", "primary-free"), true)
    const recovered = failures.apply(eligible, [primary, sibling], 1_001)
    assert.equal(recovered.get(modelKey(primary))?.cooldownUntil, undefined, JSON.stringify(error))
    assert.equal(recovered.get(modelKey(sibling))?.cooldownUntil, undefined, JSON.stringify(error))
  }
})

test("an auth or unknown probe failure changes nothing", () => {
  for (const error of [{ type: "provider.auth", status: 401 }, { type: "provider.unknown" }]) {
    const failures = new FailureCooldowns(300_000, groups)
    failures.reportFailure({ providerID: "opencode", modelID: "primary-free", classification: "temporary-rate-limit" }, 0)
    const failure = classifyRetryFailure(error, "opencode", "primary-free")
    assert.notEqual(failure.report?.classification, "temporary-rate-limit")
    assert.notEqual(failure.report?.classification, "quota-exhausted")
    const cooling = failures.apply(eligible, [primary, sibling], 1)
    assert.equal(cooling.get(modelKey(primary))?.cooldownUntil, 300_000, JSON.stringify(error))
  }
})
