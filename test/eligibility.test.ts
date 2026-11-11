import assert from "node:assert/strict"
import test from "node:test"
import type { ModelRef } from "../src/config.ts"
import { buildQuotaEligibility, moduleUsageDecision, quotaPaces } from "../src/eligibility.ts"
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

function withGoWindows(windows: UsageSource["windows"], stale = false): UsageReadResult {
  return {
    status: "ok",
    snapshot: {
      updatedAt: 1_000,
      sources: {
        go: { ...source("available"), stale, windows },
        codex: source("available"),
        cursor: source("unknown"),
      } satisfies Record<UsageSourceID, UsageSource>,
    },
  }
}

test("pace is limited by the tightest window, and finished ones stop constraining", () => {
  const minute = 60_000
  const at = 1_000 * minute
  const reading = withGoWindows([
    // Roomy short window: 96% left over 40 minutes, so 2.4% a minute.
    { name: "rolling", usedPercent: 4, state: "ok", resetsAt: at + 40 * minute },
    // The weekly window is nearly spent with two days to go: 1% over 2880 minutes.
    { name: "weekly", usedPercent: 99, state: "ok", resetsAt: at + 2 * 24 * 60 * minute },
    // Already reset: it constrains nothing.
    { name: "monthly", usedPercent: 60, state: "ok", resetsAt: at },
  ])
  const pace = quotaPaces({ "opencode-go": "go", openai: "codex" }, reading, at)
  const go = pace({ providerID: "opencode-go", modelID: "paid-one" })

  assert.ok(Math.abs((go as number) - 1 / (2 * 24 * 60)) < 1e-9)
  // A stale source and an untracked provider have no pace, so they sort last.
  const stale = withGoWindows([{ name: "weekly", usedPercent: 10, state: "ok", resetsAt: at + 60 * minute }], true)
  assert.equal(quotaPaces({ openai: "go" }, stale, at)({ providerID: "openai", modelID: "codex-model" }), undefined)
  assert.equal(pace({ providerID: "ollama", modelID: "local-model" }), undefined)
})

test("a usable window keeps its headroom; only a full window or a reported limit blocks", () => {
  const eligible = (windows: UsageSource["windows"], stale = false) =>
    buildQuotaEligibility(registry, { "opencode-go": "go", openai: "codex" }, ["opencode-go/free-model"], withGoWindows(windows, stale))
      .get(modelKey(registry[0]))?.status

  // Near the cap is still usable: the remaining percentage points are spendable.
  assert.equal(eligible([{ name: "weekly", usedPercent: 90, state: "ok", resetsAt: null }]), "available")
  assert.equal(eligible([{ name: "weekly", usedPercent: 95, state: "ok", resetsAt: null }]), "available")
  assert.equal(eligible([{ name: "weekly", usedPercent: 99.9, state: "ok", resetsAt: null }]), "available")
  assert.equal(eligible([{ name: "weekly", usedPercent: 40, state: "ok", resetsAt: null }]), "available")
  assert.equal(eligible([{ name: "weekly", usedPercent: 100, state: "ok", resetsAt: null }]), "limited")
  assert.equal(eligible([{ name: "weekly", usedPercent: 100.5, state: "ok", resetsAt: null }]), "limited")
  // A provider that reports a limit or a rate-limited window blocks at any percentage.
  assert.equal(eligible([{ name: "weekly", usedPercent: 5, state: "rate-limited", resetsAt: null }]), "limited")
  const providerLimited = withGoWindows([{ name: "weekly", usedPercent: 20, state: "ok", resetsAt: null }])
  providerLimited.snapshot.sources.go.availability = "limited"
  assert.equal(
    buildQuotaEligibility(registry, { "opencode-go": "go", openai: "codex" }, [], providerLimited)
      .get(modelKey(registry[0]))?.status,
    "limited",
  )
  // Old evidence must never block, whatever the window says.
  assert.equal(eligible([{ name: "weekly", usedPercent: 100, state: "rate-limited", resetsAt: null }], true), "available")

  // The module gate reads the same ceiling.
  const decision = (windows: UsageSource["windows"]) =>
    moduleUsageDecision(registry[0], { "opencode-go": "go" }, [], withGoWindows(windows))
  assert.deepEqual(decision([{ name: "weekly", usedPercent: 99.9, state: "ok", resetsAt: null }]), { quota: "available" })
  assert.deepEqual(decision([{ name: "weekly", usedPercent: 100, state: "ok", resetsAt: null }]), { quota: "limited", skip: "limited" })
})

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
