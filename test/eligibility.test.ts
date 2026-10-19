import assert from "node:assert/strict"
import test from "node:test"
import type { ModelRef } from "../src/config.ts"
import { buildQuotaEligibility } from "../src/eligibility.ts"
import { modelKey, selectModel } from "../src/select.ts"
import type { UsageReadResult, UsageSource, UsageSourceID } from "../src/usage.ts"
import { normalizeUsageSnapshot } from "../src/usage.ts"

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
  // codex is "unknown" in this snapshot: absence of a limit must not block.
  assert.equal(eligibility.get(modelKey(registry[3]))?.status, "available")
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

test("missing usage status leaves mapped providers available, not blocked", () => {
  const eligibility = buildQuotaEligibility(registry, { "opencode-go": "go" }, [], {
    status: "unavailable",
    reason: "rpc-error",
  })
  assert.equal(eligibility.get(modelKey(registry[0]))?.status, "available")
  assert.equal(eligibility.get(modelKey(registry[4]))?.status, "available")

  // Unusable usage must not block a plan: the mapped model is selectable.
  const selection = selectModel([registry[0]], registry, eligibility, 1_000)
  assert.equal(selection.status, "selected")
})

test("stale usage (limit no longer fresh) does not block, a fresh limit still does", () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  const rawSource = (checkedAt: string, availability: string, state: string, usedPercent: number) => ({
    authenticated: true,
    checkedAt,
    stale: false,
    error: null,
    windows: [{ name: "week", usedPercent, state, resetsAt: null }],
    nextAvailableAt: null,
    availability,
  })
  const raw = {
    schemaVersion: 1,
    updatedAt: iso(Date.now()),
    models: { go: {} },
    sources: {
      // checkedAt 6 minutes ago: past the 5-minute freshness window -> not fresh.
      go: rawSource(iso(Date.now() - 6 * 60_000), "limited", "rate-limited", 100),
      codex: rawSource(iso(Date.now()), "available", "ok", 20),
      cursor: rawSource(iso(Date.now()), "available", "ok", 20),
    },
  }
  const stale = normalizeUsageSnapshot(raw)
  assert.equal(stale.status, "ok")
  if (stale.status === "ok") assert.equal(stale.snapshot.sources.go.availability, "unknown")

  const staleEligibility = buildQuotaEligibility([registry[0]], { "opencode-go": "go" }, [], stale)
  assert.equal(staleEligibility.get(modelKey(registry[0]))?.status, "available")
  assert.equal(selectModel([registry[0]], registry, staleEligibility, 1_000).status, "selected")

  const freshEligibility = buildQuotaEligibility([registry[0]], { "opencode-go": "go" }, [], usage("limited", "available"))
  const blocked = selectModel([registry[0]], registry, freshEligibility, 1_000)
  assert.equal(blocked.status, "no-eligible")
  if (blocked.status === "no-eligible") {
    assert.deepEqual(blocked.skipped.map(({ reason }) => reason.code), ["limited"])
  }
})
