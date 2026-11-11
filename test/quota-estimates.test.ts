import assert from "node:assert/strict"
import test from "node:test"
import { buildQuotaEligibility } from "../src/eligibility.ts"
import { registerAgentRouting } from "../src/agent-routing.ts"
import { parseConfig } from "../src/config.ts"
import { QuotaEstimates, QUOTA_ESTIMATE_STORAGE_KEY } from "../src/quota-estimates.ts"
import type { UsageReadResult, UsageSnapshot, UsageSource, UsageSourceID, UsageWindow } from "../src/usage.ts"

const MIN = 60_000
const t0 = Date.now()

function usageWindow(percent: number, resetsAt: number | null = null, resetEstimated?: boolean): UsageWindow {
  return { name: "weekly", usedPercent: percent, state: "ok", resetsAt, ...(resetEstimated === undefined ? {} : { resetEstimated }) }
}

function usageAt(
  at: number,
  percent: number,
  options: {
    sourceID?: UsageSourceID
    resetsAt?: number | null
    resetEstimated?: boolean
    stale?: boolean
    authenticated?: boolean
    error?: string | null
    windows?: UsageWindow[]
  } = {},
): UsageReadResult {
  const sourceID = options.sourceID ?? "go"
  const source: UsageSource = {
    authenticated: options.authenticated ?? true,
    checkedAt: at,
    stale: options.stale ?? false,
    error: options.error ?? null,
    windows: options.windows ?? [usageWindow(percent, options.resetsAt ?? null, options.resetEstimated)],
    nextAvailableAt: null,
    availability: "available",
  }
  const empty: UsageSource = {
    authenticated: true, checkedAt: at, stale: false, error: null, windows: [], nextAvailableAt: null, availability: "available",
  }
  const sources: UsageSnapshot["sources"] = { go: empty, codex: empty, cursor: empty }
  sources[sourceID] = source
  return { status: "ok", snapshot: { updatedAt: at, sources } }
}

function recorded(samples: Array<{ at: number; percent: number; resetsAt?: number | null }>): QuotaEstimates {
  const estimates = new QuotaEstimates()
  for (const sample of samples) estimates.observe(usageAt(sample.at, sample.percent, { resetsAt: sample.resetsAt ?? null }), sample.at)
  return estimates
}

test("a positive percentage trend estimates the quota cutoff once 15 minutes of history exists", () => {
  const resetAt = t0 + 30 * MIN
  const estimates = recorded([
    { at: t0, percent: 40, resetsAt: resetAt },
    { at: t0 + 15 * MIN, percent: 50, resetsAt: resetAt },
  ])
  const estimate = estimates.estimate("go", usageWindow(50, resetAt), t0 + 15 * MIN)

  assert.equal(estimate?.status, "estimated")
  assert.equal(estimate?.cutoffPercent, 100)
  assert.equal(estimate?.sampleCount, 2)
  assert.equal(estimate?.spanMs, 15 * MIN)
  assert.ok(Math.abs((estimate?.ratePerMinute ?? 0) - 10 / 15) < 1e-9)
  // 50 percentage points left at 2/3 point per minute is exactly 75 minutes.
  assert.equal(estimate?.cutoffAt, t0 + 15 * MIN + 75 * MIN)
  // The reset in 30 minutes arrives first; the estimate still reports the
  // truthful cutoff so the page can say reset-first instead of overclaiming.
  assert.ok((estimate?.cutoffAt ?? 0) > resetAt)
})

test("cached checkedAt values are one observation and never inflate the rate", () => {
  const estimates = recorded([{ at: t0, percent: 40 }, { at: t0 + 15 * MIN, percent: 50 }])
  assert.equal(estimates.observe(usageAt(t0 + 15 * MIN, 50), t0 + 15 * MIN), false)
  const estimate = estimates.estimate("go", usageWindow(50), t0 + 15 * MIN)
  assert.equal(estimate?.sampleCount, 2)
  assert.equal(estimate?.ratePerMinute, 10 / 15)
})

test("warmup and single observations stay insufficient; a fresh flat history reports no recent usage", () => {
  const warmup = recorded([{ at: t0, percent: 40 }, { at: t0 + 10 * MIN, percent: 45 }])
  assert.equal(warmup.estimate("go", usageWindow(45), t0 + 10 * MIN)?.status, "insufficient-history")
  const flat = recorded([
    { at: t0, percent: 40 },
    { at: t0 + 5 * MIN, percent: 40 },
    { at: t0 + 10 * MIN, percent: 40 },
    { at: t0 + 15 * MIN, percent: 40 },
  ])
  assert.equal(flat.estimate("go", usageWindow(40), t0 + 15 * MIN)?.status, "no-recent-usage")
  const single = recorded([{ at: t0, percent: 40 }])
  assert.equal(single.estimate("go", usageWindow(40), t0)?.status, "insufficient-history")
  assert.equal(single.estimate("go", usageWindow(40), t0)?.sampleCount, 1)
})

test("a quota reset, a percentage drop, an out-of-order read and a long gap start a new line", () => {
  const resetAt = t0 + 60 * MIN
  const base = [{ at: t0, percent: 40, resetsAt: resetAt }, { at: t0 + 15 * MIN, percent: 50, resetsAt: resetAt }]
  const after = t0 + 16 * MIN
  const reset = recorded(base)
  reset.observe(usageAt(after, 50, { resetsAt: resetAt + 1 }), after)
  assert.equal(reset.estimate("go", usageWindow(50, resetAt + 1), after)?.sampleCount, 1)

  const estimatedChange = recorded(base)
  estimatedChange.observe(usageAt(after, 50, { resetsAt: resetAt, resetEstimated: true }), after)
  assert.equal(estimatedChange.estimate("go", usageWindow(50, resetAt, true), after)?.sampleCount, 1)

  const drop = recorded(base)
  drop.observe(usageAt(after, 45, { resetsAt: resetAt }), after)
  assert.equal(drop.estimate("go", usageWindow(45, resetAt), after)?.sampleCount, 1)

  const outOfOrder = recorded(base)
  outOfOrder.observe(usageAt(t0 + 12 * MIN, 60, { resetsAt: resetAt }), after)
  assert.equal(outOfOrder.estimate("go", usageWindow(60, resetAt), after)?.sampleCount, 1)

  const gap = recorded(base)
  gap.observe(usageAt(t0 + 31 * MIN, 60, { resetsAt: resetAt }), t0 + 31 * MIN)
  assert.equal(gap.estimate("go", usageWindow(60, resetAt), t0 + 31 * MIN)?.sampleCount, 1)
})

test("stale, unauthenticated, errored and future observations cannot build confidence", () => {
  const stale = recorded([{ at: t0, percent: 40 }])
  stale.observe(usageAt(t0 + 5 * MIN, 50, { stale: true, windows: [usageWindow(50)] }), t0 + 5 * MIN)
  assert.equal(stale.estimate("go", usageWindow(50), t0 + 5 * MIN)?.sampleCount, 1)

  const unauthenticated = recorded([{ at: t0, percent: 40 }])
  unauthenticated.observe(usageAt(t0 + 5 * MIN, 50, { authenticated: false }), t0 + 5 * MIN)
  assert.equal(unauthenticated.estimate("go", usageWindow(50), t0 + 5 * MIN)?.sampleCount, 0)

  const errored = recorded([{ at: t0, percent: 40 }])
  errored.observe(usageAt(t0 + 5 * MIN, 50, { error: "authentication failed" }), t0 + 5 * MIN)
  assert.equal(errored.estimate("go", usageWindow(50), t0 + 5 * MIN)?.sampleCount, 0)

  const future = new QuotaEstimates()
  future.observe(usageAt(t0 + 5 * MIN, 40), t0)
  assert.equal(future.estimate("go", usageWindow(40), t0 + 5 * MIN)?.sampleCount, 0)
  assert.equal(future.stale().status, "stale")

  // Upstream can cache stale=false next to an old checkedAt: the clock wins.
  const cached = new QuotaEstimates()
  cached.observe(usageAt(t0 - 6 * MIN, 40, { stale: false }), t0)
  assert.equal(cached.estimate("go", usageWindow(40), t0)?.sampleCount, 0)
})

test("expired history is pruned and a positive history with no fresh observation stays stale", () => {
  const expired = recorded([{ at: t0 - 70 * MIN, percent: 40 }])
  const before = expired.snapshot()
  assert.equal(expired.estimate("go", usageWindow(40), t0)?.sampleCount, 0)

  // Reading the estimate must not prune the stored history: diagnostics are
  // side-effect free, and only observe() may drop samples.
  expired.estimate("go", usageWindow(40), t0)
  assert.deepEqual(expired.snapshot(), before)

  const old = recorded([{ at: t0 - 40 * MIN, percent: 40 }, { at: t0 - 25 * MIN, percent: 50 }])
  assert.equal(old.estimate("go", usageWindow(50), t0)?.status, "stale")
  assert.equal(old.estimate("go", usageWindow(50), t0)?.cutoffAt, undefined)
})

test("history round-trips through storage and stays bounded in samples and series", async () => {
  const stored = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => stored.get(key),
    set: async (key: string, value: unknown) => { stored.set(key, value) },
  }
  const original = recorded([{ at: t0, percent: 40 }, { at: t0 + 10 * MIN, percent: 45 }, { at: t0 + 20 * MIN, percent: 50 }])
  await original.save(storage)
  assert.ok(stored.has(QUOTA_ESTIMATE_STORAGE_KEY))
  const reloaded = await QuotaEstimates.load(storage, t0 + 20 * MIN)
  assert.deepEqual(reloaded.estimate("go", usageWindow(50), t0 + 20 * MIN), original.estimate("go", usageWindow(50), t0 + 20 * MIN))

  const dense = new QuotaEstimates()
  for (let index = 0; index < 180; index++) {
    const at = t0 + index * 20_000
    dense.observe(usageAt(at, 10 + index * 0.1), at)
  }
  const denseSnapshot = dense.snapshot()
  assert.ok(Object.values(denseSnapshot.series)[0].samples.length <= 120)
  assert.equal(dense.estimate("go", usageWindow(28), t0 + 179 * 20_000)?.sampleCount, 120)

  const manyWindows = new QuotaEstimates()
  manyWindows.observe(usageAt(t0, 10, {
    windows: Array.from({ length: 40 }, (_, index) => ({ name: `window-${index}`, usedPercent: 10, state: "ok", resetsAt: null })),
  }), t0)
  assert.ok(Object.keys(manyWindows.snapshot().series).length <= 32)
})

test("a reported reset in the past stops projection of the old cycle", () => {
  const estimates = recorded([
    { at: t0 - 15 * MIN, percent: 40, resetsAt: t0 },
    { at: t0, percent: 95, resetsAt: t0 },
  ])
  const estimate = estimates.estimate("go", usageWindow(95, t0), t0)
  assert.equal(estimate?.status, "insufficient-history")
  assert.equal(estimate?.cutoffAt, undefined)
})

test("cutoff is reported from observation alone, without a slope", () => {
  const estimates = new QuotaEstimates()
  const estimate = estimates.estimate("go", usageWindow(100), t0)
  assert.equal(estimate?.status, "cutoff-reached")
  assert.equal(estimate?.cutoffPercent, 100)
  assert.equal(estimate?.sampleCount, 0)
  assert.equal(estimate?.cutoffAt, undefined)
})

test("forecasts do not mutate usage or quota eligibility", () => {
  const config = parseConfig({ usageSources: { go: "go" } })
  const usage = usageAt(t0, 85, { resetsAt: t0 + 30 * MIN })
  const before = [...buildQuotaEligibility([{ providerID: "go", modelID: "model-a" }], config.usageSources, [], usage)]
  const estimates = new QuotaEstimates()
  estimates.observe(usage, t0)
  const after = [...buildQuotaEligibility([{ providerID: "go", modelID: "model-a" }], config.usageSources, [], usage)]
  assert.deepEqual(after, before)
  assert.equal(after[0][1].status, "available")
})

test("router status blocks a cutoff estimate when a cached non-stale timestamp is older than five minutes", async () => {
  const realNow = Date.now
  let clock = t0
  Date.now = () => clock
  const config = parseConfig({ usageSources: { openai: "codex" } })
  const usage = usageAt(t0, 95, { sourceID: "codex", resetsAt: t0 + 30 * MIN })
  const storage = {
    get: async () => undefined,
    set: async () => {},
    remove: async () => {},
    scan: async () => ({ entries: [] as unknown[] }),
  }
  let routing: Awaited<ReturnType<typeof registerAgentRouting>>
  try {
    routing = await registerAgentRouting({
      model: { list: async () => ({ data: [{ providerID: "openai", id: "model-a", enabled: true }] }) },
      storage,
      rpc: () => ({ status: async () => usage }),
      agent: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
    } as unknown as Parameters<typeof registerAgentRouting>[0], config, usage)
    assert.ok(routing)
    clock = t0 + 6 * MIN
    const status = await routing.status() as {
      sources: Record<string, { stale: boolean; windows: Array<{ usedPercent: number; estimate?: { status: string } }> }>
    }
    assert.equal(status.sources.openai.stale, false)
    assert.equal(status.sources.openai.windows[0].usedPercent, 95)
    assert.equal(status.sources.openai.windows[0].estimate?.status, "stale")
  } finally {
    Date.now = realNow
    await routing!.dispose()
  }
})

test("quota-only routing keeps the router and attaches estimates to copied status windows", async () => {
  const config = parseConfig({ usageSources: { openai: "codex" } })
  const resetAt = t0 + 30 * MIN
  const history = new QuotaEstimates()
  history.observe(usageAt(t0 - 15 * MIN, 40, { sourceID: "codex", resetsAt: resetAt }), t0 - 15 * MIN)
  history.observe(usageAt(t0, 50, { sourceID: "codex", resetsAt: resetAt }), t0)
  const stored = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => stored.get(key),
    set: async (key: string, value: unknown) => { stored.set(key, value) },
    remove: async (key: string) => { stored.delete(key) },
    scan: async () => ({ entries: [] as unknown[] }),
  }
  await history.save(storage)
  const usage = usageAt(t0, 50, { sourceID: "codex", resetsAt: resetAt })
  const routing = await registerAgentRouting({
    model: { list: async () => ({ data: [{ providerID: "openai", id: "model-a", enabled: true }] }) },
    storage,
    rpc: () => ({ status: async () => usage }),
    agent: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
  } as unknown as Parameters<typeof registerAgentRouting>[0], config, usage)
  assert.ok(routing)
  try {
    const status = await routing.status() as {
      status: string
      sources: Record<string, { availability: string; windows: Array<{ usedPercent: number; estimate?: { status: string; sampleCount: number } }> }>
    }
    assert.equal(status.status, "ok")
    assert.equal(status.sources.openai.availability, "available")
    assert.equal(status.sources.openai.windows[0].usedPercent, 50)
    assert.equal(status.sources.openai.windows[0].estimate?.status, "estimated")
    assert.equal(status.sources.openai.windows[0].estimate?.sampleCount, 2)
  } finally {
    await routing.dispose()
  }
})
