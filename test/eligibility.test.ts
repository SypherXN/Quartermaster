import assert from "node:assert/strict"
import test from "node:test"
import type { ModelRef } from "../src/config.ts"
import {
  buildQuotaEligibility, moduleUsageDecision, quotaFreshPaces, quotaPaces, quotaProtectedPaces,
} from "../src/eligibility.ts"
import { QuotaEstimates } from "../src/quota-estimates.ts"
import { modelKey, selectModel } from "../src/select.ts"
import type { UsageReadResult, UsageSource, UsageSourceID, UsageWindow } from "../src/usage.ts"
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

const MINUTE = 60_000

function freshSourceAt(at: number, windows: UsageWindow[], over: Partial<UsageSource> = {}): UsageSource {
  return {
    authenticated: true, checkedAt: at, stale: false, error: null, windows,
    nextAvailableAt: null, availability: "available", ...over,
  }
}

function readingAt(at: number, sources: Partial<Record<UsageSourceID, UsageSource>>): UsageReadResult {
  const empty = freshSourceAt(at, [])
  return {
    status: "ok",
    snapshot: { updatedAt: at, sources: { go: sources.go ?? empty, codex: sources.codex ?? empty, cursor: sources.cursor ?? empty } },
  }
}

/** History observed at each sample's own clock, for the given current window. */
function historyFor(
  sourceID: UsageSourceID,
  window: UsageWindow,
  samples: Array<{ at: number; percent: number }>,
): QuotaEstimates {
  const estimates = new QuotaEstimates()
  for (const sample of samples) {
    const observed = { ...window, usedPercent: sample.percent }
    estimates.observe(readingAt(sample.at, {
      [sourceID]: freshSourceAt(sample.at, [observed]),
    } as Partial<Record<UsageSourceID, UsageSource>>), sample.at)
  }
  return estimates
}

test("window protection lowers a risky provider despite a healthy short window", () => {
  const at = 1_000 * MINUTE
  const riskyWindows: UsageWindow[] = [
    { name: "5h", usedPercent: 40, state: "ok", resetsAt: at + 240 * MINUTE },
    // 80% used with one hour left, but the observed trend says it empties in 20 minutes.
    { name: "weekly", usedPercent: 80, state: "ok", resetsAt: at + 60 * MINUTE },
  ]
  const safeWindows: UsageWindow[] = [
    { name: "5h", usedPercent: 40, state: "ok", resetsAt: at + 300 * MINUTE },
    { name: "weekly", usedPercent: 10, state: "ok", resetsAt: at + 600 * MINUTE },
  ]
  const reading = readingAt(at, { go: freshSourceAt(at, riskyWindows), codex: freshSourceAt(at, safeWindows) })
  const estimates = historyFor("go", riskyWindows[1], [
    { at: at - 15 * MINUTE, percent: 65 },
    { at, percent: 80 },
  ])
  const sources = { "opencode-go": "go", openai: "codex" }
  const risky = { providerID: "opencode-go", modelID: "risky" }
  const safe = { providerID: "openai", modelID: "safe" }

  assert.ok(Math.abs((quotaPaces(sources, reading, at)(risky) ?? 0) - 0.25) < 1e-9)
  assert.ok((quotaPaces(sources, reading, at)(risky) ?? 0) > (quotaPaces(sources, reading, at)(safe) ?? 0),
    "ordinary pace prefers the risky provider")
  const protectedPace = quotaProtectedPaces(sources, reading, estimates, at)
  assert.ok(Math.abs((protectedPace(risky) ?? 0) - 0.25 / 3) < 1e-9, `saw ${protectedPace(risky)}`)
  assert.ok((protectedPace(risky) ?? 0) < (protectedPace(safe) ?? 0), "protection flips the ranking")
})

test("window protection is neutral for reset-first, missing and guessed forecasts", () => {
  const at = 1_000 * MINUTE
  const window: UsageWindow = { name: "weekly", usedPercent: 40, state: "ok", resetsAt: at + 60 * MINUTE }
  const sources = { "opencode-go": "go" }
  const model = { providerID: "opencode-go", modelID: "model" }
  const reading = readingAt(at, { go: freshSourceAt(at, [window]) })
  const base = quotaPaces(sources, reading, at)(model)

  // 40% used with an hour left needs 1%/min to exhaust; this 0.67%/min trend
  // reaches the cutoff after the reset, so there is no penalty.
  const resetFirst = historyFor("go", window, [
    { at: at - 15 * MINUTE, percent: 30 },
    { at, percent: 40 },
  ])
  assert.equal(quotaProtectedPaces(sources, reading, resetFirst, at)(model), base)

  // No history at all keeps ordinary pace.
  assert.equal(quotaProtectedPaces(sources, reading, new QuotaEstimates(), at)(model), base)

  // A guessed reset cannot bound the ratio, even with a steep observed trend.
  const guessed: UsageWindow = { ...window, resetEstimated: true }
  const guessedReading = readingAt(at, { go: freshSourceAt(at, [guessed]) })
  const guessedHistory = historyFor("go", guessed, [
    { at: at - 15 * MINUTE, percent: 0 },
    { at, percent: 90 },
  ])
  assert.equal(
    quotaProtectedPaces(sources, guessedReading, guessedHistory, at)(model),
    quotaPaces(sources, guessedReading, at)(model),
  )

  // A window that already reset constrains nothing and never penalizes.
  const past: UsageWindow = { name: "daily", usedPercent: 99, state: "ok", resetsAt: at }
  const mixed = readingAt(at, { go: freshSourceAt(at, [past, window]) })
  assert.equal(quotaProtectedPaces(sources, mixed, resetFirst, at)(model), quotaPaces(sources, mixed, at)(model))
})

test("window protection only trusts fresh authenticated observations", () => {  const at = 1_000 * MINUTE
  const window: UsageWindow = { name: "weekly", usedPercent: 80, state: "ok", resetsAt: at + 60 * MINUTE }
  const sources = { "opencode-go": "go" }
  const model = { providerID: "opencode-go", modelID: "model" }
  const estimates = historyFor("go", window, [
    { at: at - 15 * MINUTE, percent: 65 },
    { at, percent: 80 },
  ])
  for (const over of [
    { stale: true },
    { authenticated: false },
    { error: "authentication failed" },
    { checkedAt: at - 6 * MINUTE },
    { checkedAt: at + MINUTE },
  ]) {
    const reading = readingAt(at, { go: freshSourceAt(at, [window], over) })
    assert.equal(quotaProtectedPaces(sources, reading, estimates, at)(model), undefined, JSON.stringify(over))
  }

  // The new strategies demand a fresh clock; the older pace strategy keeps its
  // previous stale-flag-only rule.
  const old = readingAt(at, { go: freshSourceAt(at - 6 * MINUTE, [window]) })
  assert.equal(quotaFreshPaces(sources, old, at)(model), undefined)
  assert.equal(quotaPaces(sources, old, at)(model), (100 - 80) / 60)
})

test("the evidence strategies drop malformed numeric windows instead of ranking NaN", () => {
  const at = 1_000 * MINUTE
  const sources = { "opencode-go": "go" }
  const model = { providerID: "opencode-go", modelID: "model" }
  const broken: UsageWindow[] = [
    { name: "nan-percent", usedPercent: Number.NaN, state: "ok", resetsAt: at + 60 * MINUTE },
    { name: "infinite-percent", usedPercent: Number.POSITIVE_INFINITY, state: "ok", resetsAt: at + 60 * MINUTE },
    { name: "negative", usedPercent: -10, state: "ok", resetsAt: at + 60 * MINUTE },
    { name: "over", usedPercent: 140, state: "ok", resetsAt: at + 60 * MINUTE },
    { name: "nan-reset", usedPercent: 40, state: "ok", resetsAt: Number.NaN },
    { name: "infinite-reset", usedPercent: 40, state: "ok", resetsAt: Number.POSITIVE_INFINITY },
  ]
  const onlyBroken = readingAt(at, { go: freshSourceAt(at, broken) })
  assert.equal(quotaFreshPaces(sources, onlyBroken, at)(model), undefined)
  assert.equal(quotaProtectedPaces(sources, onlyBroken, new QuotaEstimates(), at)(model), undefined)

  // One valid window contributes on its own; the malformed ones never drag it
  // to NaN or below zero.
  const mixed = readingAt(at, {
    go: freshSourceAt(at, [...broken, { name: "valid", usedPercent: 20, state: "ok", resetsAt: at + 60 * MINUTE }]),
  })
  assert.equal(quotaFreshPaces(sources, mixed, at)(model), 80 / 60)
  assert.equal(quotaProtectedPaces(sources, mixed, new QuotaEstimates(), at)(model), 80 / 60)
})
