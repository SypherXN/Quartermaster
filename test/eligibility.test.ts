import assert from "node:assert/strict"
import test from "node:test"
import type { ModelRef } from "../src/config.ts"
import { buildQuotaEligibility } from "../src/eligibility.ts"
import { modelKey, selectModel } from "../src/select.ts"
import type { UsageReadResult, UsageSource, UsageSourceID } from "../src/usage.ts"

const registry: ModelRef[] = [
  { providerID: "opencode-go", modelID: "paid-one" },
  { providerID: "opencode-go", modelID: "paid-two" },
  { providerID: "opencode-go", modelID: "free-model" },
  { providerID: "openai", modelID: "codex-model" },
  { providerID: "ollama", modelID: "local-model" },
]

function source(availability: UsageSource["availability"], nextAvailableAt: number | null = null): UsageSource {
  return {
    authenticated: true,
    checkedAt: 1_000,
    stale: false,
    error: null,
    windows: availability === "limited"
      ? [{ name: "week", usedPercent: 100, state: "rate-limited", resetsAt: nextAvailableAt, resetEstimated: true }]
      : availability === "available"
        ? [{ name: "week", usedPercent: 20, state: "ok", resetsAt: nextAvailableAt }]
        : [{ name: "week", usedPercent: null, state: "unknown", resetsAt: null }],
    nextAvailableAt,
    availability,
  }
}

function usage(go: UsageSource["availability"], codex: UsageSource["availability"], nextAvailableAt: number | null = null): UsageReadResult {
  return {
    status: "ok",
    snapshot: {
      updatedAt: 1_000,
      sources: {
        go: source(go, nextAvailableAt),
        codex: source(codex),
        cursor: source("unknown"),
      } satisfies Record<UsageSourceID, UsageSource>,
    },
  }
}

test("a limited shared source excludes every mapped model except explicit exemptions", () => {
  const eligibility = buildQuotaEligibility(
    registry,
    { "opencode-go": "go", openai: "codex" },
    ["opencode-go/free-model"],
    usage("limited", "unknown"),
  )

  assert.equal(eligibility.get(modelKey(registry[0]))?.status, "limited")
  assert.equal(eligibility.get(modelKey(registry[1]))?.status, "limited")
  assert.equal(eligibility.get(modelKey(registry[2]))?.status, "available")
  assert.equal(eligibility.get(modelKey(registry[3]))?.status, "unknown")
  assert.equal(eligibility.get(modelKey(registry[4]))?.status, "available")

  const selection = selectModel(registry.slice(0, 2), registry, eligibility, 1_000)
  assert.equal(selection.status, "no-eligible")
  if (selection.status === "no-eligible") {
    assert.deepEqual(selection.skipped.map(({ reason }) => reason.code), ["limited", "limited"])
  }
})

test("unmapped toString providers stay available; explicit mappings still apply", () => {
  const model: ModelRef = { providerID: "toString", modelID: "model" }
  const snapshots: (UsageReadResult | undefined)[] = [
    undefined,
    { status: "unavailable", reason: "rpc-error" },
    usage("limited", "unknown"),
  ]
  for (const snapshot of snapshots) {
    const eligibility = buildQuotaEligibility([model], {}, [], snapshot)
    assert.equal(eligibility.get(modelKey(model))?.status, "available")
  }
  const mapped = buildQuotaEligibility([model], { toString: "go" }, [], usage("limited", "unknown"))
  assert.equal(mapped.get(modelKey(model))?.status, "limited")
})

test("estimated reset does not unblock a source, but a fresh available status does", () => {
  const limited = buildQuotaEligibility(registry, { "opencode-go": "go" }, [], usage("limited", "available", 500))
  assert.equal(limited.get(modelKey(registry[0]))?.status, "limited")

  const recovered = buildQuotaEligibility(registry, { "opencode-go": "go" }, [], usage("available", "available", 500))
  assert.equal(recovered.get(modelKey(registry[0]))?.status, "available")
})

test("missing usage status leaves mapped providers unknown, not exhausted", () => {
  const eligibility = buildQuotaEligibility(registry, { "opencode-go": "go" }, [], {
    status: "unavailable",
    reason: "rpc-error",
  })
  assert.equal(eligibility.get(modelKey(registry[0]))?.status, "unknown")
  assert.equal(eligibility.get(modelKey(registry[4]))?.status, "available")
})
