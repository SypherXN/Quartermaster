import assert from "node:assert/strict"
import test from "node:test"
import { registerAgentRouting } from "../src/agent-routing.ts"
import { parseConfig } from "../src/config.ts"
import { orderCategoryByWeightedPace } from "../src/decision.ts"
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


