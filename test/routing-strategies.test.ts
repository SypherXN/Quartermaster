import assert from "node:assert/strict"
import test from "node:test"
import { registerAgentRouting } from "../src/agent-routing.ts"
import { parseConfig } from "../src/config.ts"
import { orderCategoryByWeightedPace } from "../src/decision.ts"
import { quotaFreshHeadroom } from "../src/eligibility.ts"
import { QuotaEstimates, QUOTA_ESTIMATE_STORAGE_KEY } from "../src/quota-estimates.ts"
import { modelKey, selectAgentModel, type ModelEligibility } from "../src/select.ts"
import type { UsageReadResult, UsageSource, UsageSourceID, UsageWindow } from "../src/usage.ts"

const MIN = 60_000

function providerSource(at: number, windows: UsageWindow[], over: Partial<UsageSource> = {}): UsageSource {
  return {
    authenticated: true, checkedAt: at, stale: false, error: null, windows,
    nextAvailableAt: null, availability: "available", ...over,
  }
}

function reading(at: number, sources: Partial<Record<UsageSourceID, UsageSource>>): UsageReadResult {
  const empty = providerSource(at, [])
  return {
    status: "ok",
    snapshot: {
      updatedAt: at,
      sources: {
        go: sources.go ?? empty,
        codex: sources.codex ?? empty,
        cursor: sources.cursor ?? empty,
      },
    },
  }
}

const iso = (at: number) => new Date(at).toISOString()

function rawSource(source: UsageSource) {
  return {
    authenticated: source.authenticated,
    checkedAt: source.checkedAt === null ? null : iso(source.checkedAt),
    stale: source.stale,
    error: source.error,
    windows: source.windows.map((window) => ({
      name: window.name,
      usedPercent: window.usedPercent,
      state: window.state,
      resetsAt: window.resetsAt === null ? null : iso(window.resetsAt),
    })),
    nextAvailableAt: source.nextAvailableAt === null ? null : iso(source.nextAvailableAt),
    availability: source.availability,
  }
}

/** The gateway's raw usage shape, so refresh() can normalize it again. */
function rawReading(result: UsageReadResult): unknown {
  if (result.status !== "ok") return result
  return {
    schemaVersion: 1,
    updatedAt: iso(result.snapshot.updatedAt),
    models: { go: {} },
    sources: Object.fromEntries(Object.entries(result.snapshot.sources).map(([id, source]) => [id, rawSource(source!)])),
  }
}

function seedEstimates(
  sourceID: UsageSourceID,
  window: UsageWindow,
  samples: Array<[number, number]>,
): QuotaEstimates {
  const estimates = new QuotaEstimates()
  for (const [at, percent] of samples) {
    const observed = { ...window, usedPercent: percent }
    estimates.observe(reading(at, { [sourceID]: providerSource(at, [observed]) } as Partial<Record<UsageSourceID, UsageSource>>), at)
  }
  return estimates
}

async function harness(
  config: ReturnType<typeof parseConfig>,
  models: Array<{ providerID: string; modelID: string; variant?: string }>,
  options: { usage?: UsageReadResult; read?: () => UsageReadResult; stored?: Map<string, unknown> } = {},
) {
  const hooks: Record<string, Array<(input: {
    sessionID: string
    kind?: string
    agent?: string
    model?: { providerID: string; id: string; variant?: string }
  }) => Promise<void>>> = {}
  const commands: Record<string, { execute(input: { sessionID: string }): Promise<void> }> = {}
  const stored = options.stored ?? new Map<string, unknown>()
  const sessions: Record<string, { agent: string; model: { providerID: string; id: string; variant?: string } }> = {}
  let current = options.usage
  const routing = await registerAgentRouting({
    model: { list: async () => ({ data: models.map((model) => ({
      providerID: model.providerID, id: model.modelID, variant: model.variant, enabled: true,
    })) }) },
    storage: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: unknown) => { stored.set(key, value) },
      remove: async (key: string) => { stored.delete(key) },
      scan: async () => ({ entries: [] }),
    },
    rpc: () => ({ status: async () => {
      if (options.read) current = options.read()
      if (!current) throw new Error("not configured")
      return rawReading(current)
    } }),
    agent: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
    session: {
      hook: async (name: string, callback: (typeof hooks)[string][number]) => {
        hooks[name] ??= []
        hooks[name].push(callback)
        return { dispose: async () => {} }
      },
      get: async ({ sessionID }: { sessionID: string }) => ({ data: sessions[sessionID] }),
      switchModel: async ({ sessionID, model }: { sessionID: string; model: { providerID: string; id: string; variant?: string } }) => {
        sessions[sessionID].model = model
      },
    },
    command: {
      transform: async (callback: (editor: { add(command: { name: string; execute(input: { sessionID: string }): Promise<void> }): void }) => void) => {
        callback({ add: (command) => { commands[command.name] = command } })
        return { dispose: async () => {} }
      },
    },
    location: { directory: "project-strategies" },
  } as never, config, options.usage)
  return {
    routing: routing!,
    sessions,
    stored,
    commands,
    prompt: (sessionID: string) => hooks.prompt[0]({ sessionID }),
    request: async (sessionID: string, model: { providerID: string; id: string; variant?: string }) => {
      for (const callback of hooks["model.request"] ?? []) {
        await callback({ sessionID, kind: "primary", agent: sessions[sessionID].agent, model })
      }
    },
    retry: (sessionID: string, model: { providerID: string; id: string; variant?: string }, event: object) =>
      hooks.retry[0]({ sessionID, agent: sessions[sessionID].agent, model, ...event }),
  }
}

const slow = { providerID: "provider-slow", modelID: "m" }
const quick = { providerID: "provider-fast", modelID: "m" }
const risky = { providerID: "provider-risky", modelID: "m" }
const safe = { providerID: "provider-safe", modelID: "m" }
const first = { providerID: "provider-a", modelID: "m" }
const second = { providerID: "provider-b", modelID: "m" }
const third = { providerID: "provider-c", modelID: "m" }

/** `select` also has an explicit-model arm; tests only read the selected model. */
const selectedProvider = (result: unknown) =>
  (result as { selected?: { providerID: string } }).selected?.providerID

test("weighted-pace favors roomy opencode go over recently reset codex", (t) => {
  const at = 1_000 * MIN
  const config = parseConfig({
    categories: { fast: { models: ["go/m", "codex/m"], pick: { by: "weighted-pace" } } },
  })
  const usage = reading(at, {
    go: providerSource(at, [
      { name: "weekly", usedPercent: 30, state: "ok", resetsAt: at + 64 * 60 * MIN },
      { name: "30d", usedPercent: 20, state: "ok", resetsAt: at + 10 * 24 * 60 * MIN },
    ]),
    codex: providerSource(at, [
      { name: "5h", usedPercent: 70, state: "ok", resetsAt: at + 4 * 60 * MIN },
      { name: "7d", usedPercent: 40, state: "ok", resetsAt: at + 5 * 24 * 60 * MIN },
    ]),
  })
  const weight = quotaFreshHeadroom({ go: "go", codex: "codex" }, usage, at)
  let wins = 0
  for (let seed = 0; seed < 200; seed++) {
    if (orderCategoryByWeightedPace(config.categories.fast, weight, String(seed))[0].providerID === "go") wins++
  }
  t.diagnostic(`go share: ${wins}/200`)
  assert.ok(wins / 200 > 0.6 && wins / 200 < 0.8, `go share: ${wins}/200`)
  assert.ok(wins / 200 < 70 / 100, "softening pulls the split closer to equal than raw headroom")
  assert.ok(wins < 200, "codex still wins some draws")
})

/**
 * Unequal window lengths: go has the roomier tightest window (70% headroom) but a
 * 30-day allowance that paces at ~0.006 %/min; codex has 50% headroom but a 5-hour
 * block that would pace at ~0.208 %/min. An already-reset codex window at 99% must
 * not count. Pace would hand codex ~96% of sessions; headroom splits 70:50.
 */
const unequalUsage = (at: number) => reading(at, {
  go: providerSource(at, [
    { name: "weekly", usedPercent: 30, state: "ok", resetsAt: at + 64 * 60 * MIN },
    { name: "30d", usedPercent: 20, state: "ok", resetsAt: at + 10 * 24 * 60 * MIN },
  ]),
  codex: providerSource(at, [
    { name: "5h", usedPercent: 50, state: "ok", resetsAt: at + 4 * 60 * MIN },
    { name: "7d", usedPercent: 40, state: "ok", resetsAt: at + 5 * 24 * 60 * MIN },
    { name: "5h-old", usedPercent: 99, state: "ok", resetsAt: at - MIN },
  ]),
})

async function goShare(
  pick: Record<string, unknown>,
  sessions = 200,
  usageAt: (at: number) => UsageReadResult = unequalUsage,
) {
  const at = 5_000 * MIN
  const realNow = Date.now
  Date.now = () => at
  try {
    const config = parseConfig({
      categories: { fast: { models: ["provider-slow/m", "provider-fast/m"], pick } },
      plans: { review: ["@fast"] },
      agents: { reviewer: "review" },
      usageSources: { "provider-slow": "go", "provider-fast": "codex" },
    })
    const h = await harness(config, [slow, quick], { usage: usageAt(at) })
    let wins = 0
    for (let index = 0; index < sessions; index++) {
      const id = `session-${index}`
      h.sessions[id] = { agent: "reviewer", model: { providerID: "host", id: "host" } }
      const diagnostic = await h.routing.diagnoseSession(id)
      if (selectedProvider(diagnostic?.recommendation) === "provider-slow") wins++
      else assert.equal(selectedProvider(diagnostic?.recommendation), "provider-fast")
    }
    await h.routing.dispose()
    return wins / sessions
  } finally {
    Date.now = realNow
  }
}

test("weighted-pace splits sessions by headroom, not by window length, through the router", async (t) => {
  const share = await goShare({ by: "weighted-pace" })
  t.diagnostic(`go share over 200 sessions: ${share} (sqrt(70) vs sqrt(50) expects ~0.542; raw headroom 0.583; pace would give ~0.04)`)
  assert.ok(share >= 0.45 && share <= 0.62, `go share ${share}`)
  assert.ok(share > 0.5, "the roomier provider still wins more sessions")
  assert.ok(share < 70 / 120, "softening pulls the split closer to equal than raw headroom")
  assert.ok(share < 1, "codex still wins some sessions")
})

test("weighted-pace pushes sessions toward a provider behind its monthly schedule", async (t) => {
  // The same 70-headroom fixture plus a monthly at 36% with 140 hours to go. The
  // required line there is ~58.3%, so the deficit is ~22.3 points and the weight is
  // multiplied by 1 + 22.3/25 ≈ 1.89: sqrt(64) × 1.89 against sqrt(50).
  const monthlyBehind = (at: number) => reading(at, {
    go: providerSource(at, [
      { name: "weekly", usedPercent: 30, state: "ok", resetsAt: at + 64 * 60 * MIN },
      { name: "monthly", usedPercent: 36, state: "ok", resetsAt: at + 140 * 60 * MIN },
    ]),
    codex: providerSource(at, [
      { name: "5h", usedPercent: 50, state: "ok", resetsAt: at + 4 * 60 * MIN },
      { name: "7d", usedPercent: 40, state: "ok", resetsAt: at + 5 * 24 * 60 * MIN },
    ]),
  })
  const boosted = await goShare({ by: "weighted-pace" }, 200, monthlyBehind)

  // Unboosted comparison from the same file: the same fresh headroom, sqrt only.
  const at = 5_000 * MIN
  const config = parseConfig({
    categories: { fast: { models: ["provider-slow/m", "provider-fast/m"], pick: { by: "weighted-pace" } } },
  })
  const headroom = quotaFreshHeadroom({ "provider-slow": "go", "provider-fast": "codex" }, monthlyBehind(at), at)
  let plainWins = 0
  for (let seed = 0; seed < 200; seed++) {
    const order = orderCategoryByWeightedPace(config.categories.fast, (model) => {
      const room = headroom(model)
      return room === undefined ? undefined : Math.sqrt(room)
    }, String(seed))
    if (order[0].providerID === "provider-slow") plainWins++
  }
  const plain = plainWins / 200
  t.diagnostic(`monthly-boosted share ${boosted} vs unboosted ${plain} (expects ~0.68 vs ~0.53)`)
  assert.ok(boosted > plain + 0.08, `the monthly boost moves sessions toward the provider: ${boosted} vs ${plain}`)
  assert.ok(boosted >= 0.6 && boosted <= 0.78, `boosted share ${boosted}`)
  assert.ok(plain >= 0.45 && plain <= 0.6, `unboosted share ${plain}`)
})

test("weighted-priority moves the split toward the provider given a larger explicit weight", async (t) => {
  const base = await goShare({ by: "weighted-priority", weights: { "provider-slow/m": 1, "provider-fast/m": 1 } })
  const heavy = await goShare({ by: "weighted-priority", weights: { "provider-slow/m": 1, "provider-fast/m": 4 } })
  const carried = await goShare({ by: "weighted-priority", weights: { "provider-slow/m": 400 } })
  t.diagnostic(`go share: equal weights ${base}, codex x4 ${heavy}, go x400 ${carried} (expects ~0.542, ~0.228, ~1)`)
  assert.ok(base >= 0.45 && base <= 0.62, `equal weights match weighted-pace: ${base}`)
  assert.ok(heavy < base - 0.2, `weighting codex x4 moves sessions to codex: ${heavy} vs ${base}`)
  assert.ok(heavy >= 0.1 && heavy <= 0.4, `go share with codex x4 (70 vs 200): ${heavy}`)
  assert.ok(carried > 0.95, `a large explicit weight carries the slower provider: ${carried}`)
})

test("weighted-pace picks by provider share through selection, diagnostics and admission", async () => {
  const at = 1_000 * MIN
  const realNow = Date.now
  Date.now = () => at
  try {
    const config = parseConfig({
      categories: { fast: { models: ["provider-slow/m", "provider-fast/m"], pick: { by: "weighted-pace" } } },
      plans: { review: ["@fast"] },
      agents: { reviewer: "review" },
      usageSources: { "provider-slow": "go", "provider-fast": "codex" },
    })
    const usage = reading(at, {
      go: providerSource(at, [{ name: "weekly", usedPercent: 99.9, state: "ok", resetsAt: at + 60 * MIN }]),
      codex: providerSource(at, [{ name: "weekly", usedPercent: 1, state: "ok", resetsAt: at + 60 * MIN }]),
    })
    const h = await harness(config, [slow, quick], { usage })
    h.sessions.s = { agent: "reviewer", model: { providerID: "host", id: "host" } }

    const selected = await h.routing.select("reviewer")
    assert.equal(selectedProvider(selected), "provider-fast")
    const again = await h.routing.select("reviewer")
    assert.equal(selectedProvider(again), selectedProvider(selected), "a no-session call is stable for its agent/plan/hour")
    assert.equal(selectedProvider(await h.routing.selectPlan("review")), "provider-fast")

    const diagnostic = await h.routing.diagnoseSession("s")
    const repeat = await h.routing.diagnoseSession("s")
    assert.equal(diagnostic?.recommendation.selected?.providerID, "provider-fast")
    assert.deepEqual(repeat?.recommendation, diagnostic?.recommendation, "diagnostics repeat without mutable state")

    await h.prompt("s")
    assert.deepEqual(h.sessions.s.model, { providerID: "provider-fast", id: "m" })
    await h.routing.dispose()
  } finally {
    Date.now = realNow
  }
})

test("an explicit weight must be large enough to outweigh headroom", async () => {
  const at = 1_500 * MIN
  const realNow = Date.now
  Date.now = () => at
  try {
    const config = parseConfig({
      categories: {
        fast: {
          models: ["provider-slow/m", "provider-fast/m"],
          pick: { by: "weighted-priority", weights: { "provider-slow/m": 4 } },
        },
      },
      plans: { review: ["@fast"] },
      agents: { reviewer: "review" },
      usageSources: { "provider-slow": "go", "provider-fast": "codex" },
    })
    // Nearly-spent preferred provider, roomy backup: the explicit 4x weight is not
    // enough to overcome sqrt(0.1) against sqrt(99), so the backup still wins here:
    // the weight has to be large enough to matter, not magic.
    const usage = reading(at, {
      go: providerSource(at, [{ name: "weekly", usedPercent: 99.9, state: "ok", resetsAt: at + 60 * MIN }]),
      codex: providerSource(at, [{ name: "weekly", usedPercent: 1, state: "ok", resetsAt: at + 60 * MIN }]),
    })
    const h = await harness(config, [slow, quick], { usage })
    h.sessions.s = { agent: "reviewer", model: { providerID: "host", id: "host" } }

    // The softened headroom keeps the backup ahead, so the weight has to be large
    // enough to matter, not magic.
    assert.equal(selectedProvider(await h.routing.select("reviewer")), "provider-fast")

    // Same category without the weight follows position at equal pace, so the
    // declared first entry takes the draw.
    const ordered = parseConfig({
      categories: { fast: { models: ["provider-slow/m", "provider-fast/m"], pick: { by: "weighted-priority" } } },
      plans: { review: ["@fast"] },
      agents: { reviewer: "review" },
      usageSources: { "provider-slow": "go", "provider-fast": "codex" },
    })
    const equal = reading(at, {
      go: providerSource(at, [{ name: "weekly", usedPercent: 50, state: "ok", resetsAt: at + 60 * MIN }]),
      codex: providerSource(at, [{ name: "weekly", usedPercent: 50, state: "ok", resetsAt: at + 60 * MIN }]),
    })
    const ranked = await harness(ordered, [slow, quick], { usage: equal })
    ranked.sessions.s = { agent: "reviewer", model: { providerID: "host", id: "host" } }
    assert.equal(selectedProvider(await ranked.routing.select("reviewer")), "provider-slow")
    await ranked.routing.dispose()
    await h.routing.dispose()
  } finally {
    Date.now = realNow
  }
})

test("weighted-pace orders the retry fallback with the same session context", async () => {
  const at = 2_000 * MIN
  const realNow = Date.now
  Date.now = () => at
  try {
    const config = parseConfig({
      categories: { fast: { models: ["provider-a/m", "provider-b/m", "provider-c/m"], pick: { by: "weighted-pace" } } },
      plans: { review: ["@fast"] },
      agents: { reviewer: "review" },
      usageSources: { "provider-a": "go", "provider-b": "codex", "provider-c": "cursor" },
    })
    const usage = reading(at, {
      go: providerSource(at, [{ name: "weekly", usedPercent: 99.9, state: "ok", resetsAt: at + 60 * MIN }]),
      codex: providerSource(at, [{ name: "weekly", usedPercent: 99, state: "ok", resetsAt: at + 60 * MIN }]),
      cursor: providerSource(at, [{ name: "weekly", usedPercent: 1, state: "ok", resetsAt: at + 60 * MIN }]),
    })
    const h = await harness(config, [first, second, third], { usage })
    h.sessions.s = { agent: "reviewer", model: { providerID: "provider-a", id: "m" } }

    await h.request("s", h.sessions.s.model)
    await h.retry("s", h.sessions.s.model, {
      decision: { retry: true },
      error: { type: "unknown", message: "Rate limit exceeded. Please try again later." },
    })
    // Both b and c remain unattempted; the strategy's order puts c first.
    assert.deepEqual(h.sessions.s.model, { providerID: "provider-c", id: "m" })
    await h.routing.dispose()
  } finally {
    Date.now = realNow
  }
})

test("window-protection holds back a risky provider, keeps its sticky pick, then lets it go", async () => {
  const at = 3_000 * MIN
  const realNow = Date.now
  let now = at
  Date.now = () => now
  try {
    const weekly: UsageWindow = { name: "weekly", usedPercent: 80, state: "ok", resetsAt: at + 60 * MIN }
    let riskyWeekly = 80
    let safeWeekly = 10
    const usageNow = () => reading(now, {
      go: providerSource(now, [
        { name: "5h", usedPercent: 40, state: "ok", resetsAt: at + 240 * MIN },
        { ...weekly, usedPercent: riskyWeekly },
      ]),
      codex: providerSource(now, [
        { name: "5h", usedPercent: 40, state: "ok", resetsAt: at + 300 * MIN },
        { name: "weekly", usedPercent: safeWeekly, state: "ok", resetsAt: at + 600 * MIN },
      ]),
    })
    const estimates = seedEstimates("go", weekly, [[at - 15 * MIN, 65], [at, 80]])
    const stored = new Map<string, unknown>([[QUOTA_ESTIMATE_STORAGE_KEY, estimates.snapshot()]])
    const config = parseConfig({
      categories: { guarded: { models: ["provider-risky/m", "provider-safe/m"], pick: { by: "window-protection" } } },
      plans: { review: ["@guarded"] },
      agents: { reviewer: "review" },
      usageSources: { "provider-risky": "go", "provider-safe": "codex" },
    })
    const h = await harness(config, [risky, safe], { usage: usageNow(), read: usageNow, stored })
    h.sessions.s = { agent: "reviewer", model: { providerID: "host", id: "host" } }

    const selected = await h.routing.select("reviewer")
    assert.equal(selectedProvider(selected), "provider-safe", "a fresh exhaust-before-reset forecast beats higher pace")
    await h.prompt("s")
    assert.deepEqual(h.sessions.s.model, { providerID: "provider-safe", id: "m" })

    // Flip the evidence: risky becomes healthy while safe is nearly spent. The
    // category's active sticky model must still hold inside the idle hour.
    riskyWeekly = 1
    safeWeekly = 90
    now += 10 * MIN
    await h.prompt("s")
    assert.equal(h.sessions.s.model.providerID, "provider-safe", "the active sticky pick wins over the rank flip")
    const diagnostic = await h.routing.diagnoseSession("s")
    assert.equal(diagnostic?.recommendation.reasonCode, "category-sticky")

    now += 61 * MIN
    await h.prompt("s")
    assert.equal(h.sessions.s.model.providerID, "provider-risky", "after the idle hour the new ranking applies")
    await h.routing.dispose()
  } finally {
    Date.now = realNow
  }
})

test("window-protection without history, and an earlier limited slot, fall back cleanly", async () => {
  const at = 4_000 * MIN
  const realNow = Date.now
  Date.now = () => at
  try {
    const usage = reading(at, {
      go: providerSource(at, [
        { name: "5h", usedPercent: 40, state: "ok", resetsAt: at + 240 * MIN },
        { name: "weekly", usedPercent: 80, state: "ok", resetsAt: at + 60 * MIN },
      ]),
      codex: providerSource(at, [
        { name: "5h", usedPercent: 40, state: "ok", resetsAt: at + 300 * MIN },
        { name: "weekly", usedPercent: 10, state: "ok", resetsAt: at + 600 * MIN },
      ]),
    })
    const config = parseConfig({
      categories: {
        guarded: { models: ["provider-risky/m"], pick: { by: "window-protection" } },
        spare: { models: ["provider-safe/m"] },
      },
      plans: { review: ["@guarded", "@spare"] },
      agents: { reviewer: "review" },
      usageSources: { "provider-risky": "go", "provider-safe": "codex" },
    })
    const h = await harness(config, [risky, safe], { usage })
    assert.equal(selectedProvider(await h.routing.select("reviewer")), "provider-risky",
      "without forecast history the ordinary pace stands")
    await h.routing.dispose()

    // The provider reports itself limited, so the earlier plan slot yields to
    // the next category instead of failing the whole selection.
    const limitedUsage = reading(at, {
      go: providerSource(at, [{ name: "weekly", usedPercent: 100, state: "rate-limited", resetsAt: at + 60 * MIN }], { availability: "limited" }),
      codex: providerSource(at, [{ name: "weekly", usedPercent: 10, state: "ok", resetsAt: at + 600 * MIN }]),
    })
    const limited = await harness(config, [risky, safe], { usage: limitedUsage })
    assert.equal(selectedProvider(await limited.routing.select("reviewer")), "provider-safe",
      "the earlier category's exhausted model falls to the next plan slot")
    await limited.routing.dispose()
  } finally {
    Date.now = realNow
  }
})

const chosen = (result: ReturnType<typeof selectAgentModel>) =>
  result.status === "selected" ? result.model.providerID : undefined

test("weighted order keeps limited, exclusive and earlier-slot fallbacks in the plan", () => {
  const config = parseConfig({
    categories: { fast: { models: ["provider-a/m", "provider-b/m"], pick: { by: "weighted-pace" } } },
    plans: { review: ["@fast"] },
    agents: { reviewer: "review" },
  })
  const weights = (entry: { providerID: string }) => entry.providerID === "provider-a" ? 10 : 1
  const order = (category: Parameters<typeof orderCategoryByWeightedPace>[0]) =>
    orderCategoryByWeightedPace(category, weights, "ladder")
  const ahead = order(config.categories.fast)[0]
  const behind = ahead.providerID === "provider-a" ? second : first
  const limited = new Map<string, ModelEligibility>([
    [modelKey(ahead), { status: "limited" }],
    [modelKey(behind), { status: "available" }],
  ])
  assert.equal(chosen(selectAgentModel(config, "reviewer", [first, second], limited, 100, undefined, undefined, order)),
    behind.providerID, "a limited winner falls to the next weighted candidate")

  const open = new Map<string, ModelEligibility>([
    [modelKey(first), { status: "available" }],
    [modelKey(second), { status: "available" }],
  ])
  const busy = (model: { providerID: string }) => model.providerID === ahead.providerID
  assert.equal(chosen(selectAgentModel(config, "reviewer", [first, second], open, 100, undefined, busy, order)),
    behind.providerID, "an exclusive-busy winner falls to the next weighted candidate")
})

test("an earlier plan slot still beats a weighted sticky recovery", () => {
  const config = parseConfig({
    categories: { first: { models: ["provider-a/m"] }, later: { models: ["provider-b/m"] } },
    plans: { review: ["@first", "@later"] },
    agents: { reviewer: "review" },
  })
  const order = (category: Parameters<typeof orderCategoryByWeightedPace>[0]) =>
    orderCategoryByWeightedPace(category, () => 1, "sticky-ladder")
  const open = new Map<string, ModelEligibility>([
    [modelKey(first), { status: "available" }],
    [modelKey(second), { status: "available" }],
  ])
  const selected = selectAgentModel(config, "reviewer", [first, second], open, 100, undefined, undefined, order,
    { model: second, lastActiveAt: 0 })
  assert.equal(chosen(selected), "provider-a", "the earlier category outranks the sticky fallback")
})
