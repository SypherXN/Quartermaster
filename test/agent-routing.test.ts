import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import { applyAgentRouting, registerAgentRouting } from "../src/agent-routing.ts"
import { parseConfig } from "../src/config.ts"
import { modelKey, type ModelEligibility } from "../src/select.ts"
import { TokenBudgetGate } from "../src/telemetry/budget-gate.ts"
import type { TokenTelemetryRecord } from "../src/telemetry/types.ts"
import { normalizeUsageSnapshot } from "../src/usage.ts"
import { fixtureConfiguration } from "./configuration-fixture.ts"

const config = parseConfig({
  plans: { review: ["provider-a/primary", { id: "provider-b/backup", variant: "fast" }] },
  agents: { reviewer: "review" },
})
const primary = { providerID: "provider-a", modelID: "primary" }
const backup = { providerID: "provider-b", modelID: "backup", variant: "fast" }
const registry = [primary, backup]

function editorWith(agents: Record<string, Record<string, unknown>>) {
  const editor = {
    get: (id: string) => agents[id] as never,
    update: (id: string, change: (agent: never) => void) => change(agents[id] as never),
  } as unknown as Pick<AgentEditor, "get" | "update">
  return { editor, agents }
}

function availability(primaryStatus: ModelEligibility["status"]) {
  return new Map([
    [modelKey(primary), { status: primaryStatus }],
    [modelKey(backup), { status: "available" as const }],
  ])
}

test("routes only bound agents and preserves other agent fields and variant", () => {
  const { editor, agents } = editorWith({
    reviewer: { id: "reviewer", model: { providerID: "host", id: "old" }, system: "Review only", permissions: ["read"] },
    builder: { id: "builder", model: { providerID: "host", id: "build" } },
  })

  applyAgentRouting(editor, config, registry, availability("limited"), 0)

  assert.deepEqual(agents.reviewer.model, { providerID: "provider-b", id: "backup", variant: "fast" })
  assert.equal(agents.reviewer.system, "Review only")
  assert.deepEqual(agents.reviewer.permissions, ["read"])
  assert.deepEqual(agents.builder.model, { providerID: "host", id: "build" })
})

test("a changed availability snapshot promotes the recovered primary", () => {
  const { editor, agents } = editorWith({ reviewer: { id: "reviewer" } })

  applyAgentRouting(editor, config, registry, availability("limited"), 0)
  assert.deepEqual(agents.reviewer.model, { providerID: "provider-b", id: "backup", variant: "fast" })

  applyAgentRouting(editor, config, registry, availability("available"), 1)
  assert.deepEqual(agents.reviewer.model, { providerID: "provider-a", id: "primary" })
})

test("no eligible candidate leaves the host model unchanged", () => {
  const { editor, agents } = editorWith({ reviewer: { id: "reviewer", model: { providerID: "host", id: "original" } } })
  const unavailable = new Map([
    [modelKey(primary), { status: "unknown" as const }],
    [modelKey(backup), { status: "limited" as const }],
  ])

  applyAgentRouting(editor, config, registry, unavailable, 0)

  assert.deepEqual(agents.reviewer.model, { providerID: "host", id: "original" })
})

test("budget warnings are reported without changing candidate selection", () => {
  const budgetConfig = parseConfig({
    plans: { review: ["provider-a/primary", "provider-b/backup"] },
    agents: { reviewer: "review" },
    budgets: [{ id: "project", dimension: "project", mode: "strict", limitTokens: 10, windowMs: 10_000 }],
  })
  const record: TokenTelemetryRecord = {
    hostContractVersion: "2.0.18",
    hostEventID: "event",
    sourceEvent: "session.step.ended",
    hostSessionID: "session",
    hostMessageID: "message",
    hostProjectID: "project-a",
    parentSessionID: null,
    hostAgentID: null,
    providerID: null,
    modelID: null,
    variant: null,
    completedAt: 9_500,
    counts: { input: 8, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    usageStatus: "reported",
  }
  const reasons = new TokenBudgetGate(budgetConfig.budgets, "project-a", [record]).reasons(10_000)
  const plain = editorWith({ reviewer: { id: "reviewer", model: { providerID: "host", id: "current" } } })
  const warned = editorWith({ reviewer: { id: "reviewer", model: { providerID: "host", id: "current" } } })
  const warnings: unknown[] = []

  applyAgentRouting(plain.editor, budgetConfig, registry, availability("available"), 10_000)
  applyAgentRouting(warned.editor, budgetConfig, registry, availability("available"), 10_000, new Map(), reasons,
    (agentID, selection, budgetReasons) => warnings.push({ agentID, selection, budgetReasons }))
  applyAgentRouting(warned.editor, budgetConfig, registry, availability("available"), 10_000, new Map(), reasons,
    (agentID, selection, budgetReasons) => warnings.push({ agentID, selection, budgetReasons }))

  assert.deepEqual(warned.agents.reviewer.model, plain.agents.reviewer.model)
  assert.deepEqual(warned.agents.reviewer.model, { providerID: "provider-a", id: "primary" })
  assert.equal(warnings.length, 2)
  assert.equal((warnings[0] as { budgetReasons: typeof reasons }).budgetReasons[0].code, "cannot-guarantee-hard-cap")
})

test("agent transforms are order-sensitive but edit only the model field", () => {
  const { editor, agents } = editorWith({ reviewer: { id: "reviewer", system: "keep" } })
  agents.reviewer.model = { providerID: "earlier", id: "model" }
  applyAgentRouting(editor, config, registry, availability("available"), 0)
  assert.deepEqual(agents.reviewer.model, { providerID: "provider-a", id: "primary" })

  agents.reviewer.model = { providerID: "later", id: "model" }
  assert.deepEqual(agents.reviewer.model, { providerID: "later", id: "model" })
  assert.equal(agents.reviewer.system, "keep")
})

test("routing preloads registry before transform and reloads at the next assignment boundary", async () => {
  const calls: string[] = []
  const { editor, agents } = editorWith({ reviewer: { id: "reviewer" } })
  let transform: ((editor: AgentEditor) => void) | undefined
  const ctx = {
    model: {
      list: async () => {
        calls.push("models")
        return { data: registry.map((model) => ({ providerID: model.providerID, id: model.modelID, enabled: true })) }
      },
    },
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => ({ entries: [] }),
    },
    rpc: () => ({ status: async () => { throw new Error("not configured") } }),
    agent: {
      transform: async (callback: (editor: AgentEditor) => void) => {
        calls.push("transform")
        transform = callback
        return { dispose: async () => { calls.push("dispose") } }
      },
      reload: async () => {
        calls.push("reload")
        transform?.(editor as AgentEditor)
      },
    },
  }

  const routing = await registerAgentRouting(ctx as never, config)
  assert.deepEqual(calls, ["models", "transform", "reload"])
  assert.deepEqual(agents.reviewer.model, { providerID: "provider-a", id: "primary" })

  await routing?.reportFailure({ providerID: "provider-a", classification: "provider-outage" })
  assert.deepEqual(agents.reviewer.model, { providerID: "provider-b", id: "backup", variant: "fast" })
  await routing?.reportSuccess({ providerID: "provider-a", scope: "provider" })
  assert.deepEqual(agents.reviewer.model, { providerID: "provider-a", id: "primary" })

  await routing?.refresh(availability("limited"))
  assert.deepEqual(agents.reviewer.model, { providerID: "provider-b", id: "backup", variant: "fast" })
  await routing?.pin("reviewer", primary)
  assert.deepEqual(agents.reviewer.model, { providerID: "provider-b", id: "backup", variant: "fast" })
  assert.equal((await routing?.explain("reviewer"))?.selected?.modelID, "primary")
  assert.equal((await routing?.explain("reviewer"))?.reason, "Selected because this model is pinned for the agent.")

  await routing?.refresh(availability("available"))
  assert.deepEqual(agents.reviewer.model, { providerID: "provider-a", id: "primary" })
  assert.equal((await routing?.explain("reviewer"))?.reason, "Selected because this model is pinned for the agent.")
  assert.equal(await routing?.unpin("reviewer"), true)
  assert.equal((await routing?.explain("reviewer"))?.reason, "Selected as the highest-priority eligible candidate.")
  assert.deepEqual(calls, [
    "models", "transform", "reload", "reload", "reload", "models", "reload", "reload", "models", "reload",
    "models", "models", "models", "reload", "models",
  ])

  await routing?.dispose()
  assert.equal(calls.at(-1), "dispose")
})

test("routing picks up models registered after plugin setup", async () => {
  const lateConfig = parseConfig({
    plans: { local: ["ninfer/qwen", "opencode/fallback"] },
    agents: { "qm-test": "local" },
  })
  let models: Array<{ providerID: string; id: string; enabled: boolean }> = []
  let transform: ((editor: AgentEditor) => void) | undefined
  const { editor, agents } = editorWith({ "qm-test": { id: "qm-test" } })
  const routing = await registerAgentRouting({
    model: { list: async () => ({ data: models }) },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    rpc: () => ({ status: async () => { throw new Error("not configured") } }),
    agent: {
      transform: async (callback: (editor: AgentEditor) => void) => {
        transform = callback
        return { dispose: async () => {} }
      },
      reload: async () => transform?.(editor as AgentEditor),
    },
  } as never, lateConfig)

  models = [
    { providerID: "ninfer", id: "qwen", enabled: true },
    { providerID: "opencode", id: "fallback", enabled: true },
  ]
  const explanation = await routing?.explain("qm-test")

  assert.equal(explanation?.selected?.providerID, "ninfer")
  assert.equal(explanation?.selected?.modelID, "qwen")
  assert.deepEqual(agents["qm-test"].model, { providerID: "ninfer", id: "qwen" })
  await routing?.dispose()
})

test("a shared rate-limit group skips every member on the next selection", async () => {
  const grouped = parseConfig({
    plans: { review: [
      "opencode/deepseek-v4.1-flash-free",
      "opencode/glm-5.3-flash-free",
      "opencode/mimo-v2.6-flash-free",
      "provider-b/backup",
    ] },
    agents: { reviewer: "review" },
    sharedRateLimits: [[
      "opencode/deepseek-v4.1-flash-free",
      "opencode/glm-5.3-flash-free",
      "opencode/mimo-v2.6-flash-free",
    ]],
  })
  const models = [
    { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
    { providerID: "opencode", id: "glm-5.3-flash-free" },
    { providerID: "opencode", id: "mimo-v2.6-flash-free" },
    { providerID: "provider-b", id: "backup" },
  ]
  const { editor, agents } = editorWith({ reviewer: { id: "reviewer" } })
  let transform: ((editor: AgentEditor) => void) | undefined
  const routing = await registerAgentRouting({
    model: { list: async () => ({ data: models.map((model) => ({ ...model, enabled: true })) }) },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    rpc: () => ({ status: async () => { throw new Error("not configured") } }),
    agent: {
      transform: async (callback: (editor: AgentEditor) => void) => { transform = callback; return { dispose: async () => {} } },
      reload: async () => transform?.(editor as AgentEditor),
    },
  } as never, grouped)
  await routing?.reportFailure({
    providerID: "opencode", modelID: "deepseek-v4.1-flash-free", classification: "temporary-rate-limit",
  })
  assert.deepEqual(agents.reviewer.model, { providerID: "provider-b", id: "backup" })
  assert.deepEqual((await routing?.explain("reviewer"))?.skipped.map(({ code }) => code), ["cooldown", "cooldown", "cooldown"])
  await routing?.dispose()
})

test("a shared quota group skips every member on the next selection", async () => {
  const grouped = parseConfig({
    plans: { review: [
      "opencode/deepseek-v4.1-flash-free",
      "opencode/glm-5.3-flash-free",
      "opencode/mimo-v2.6-flash-free",
      "provider-b/backup",
    ] },
    agents: { reviewer: "review" },
    sharedRateLimits: [[
      "opencode/deepseek-v4.1-flash-free",
      "opencode/glm-5.3-flash-free",
      "opencode/mimo-v2.6-flash-free",
    ]],
  })
  const models = [
    { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
    { providerID: "opencode", id: "glm-5.3-flash-free" },
    { providerID: "opencode", id: "mimo-v2.6-flash-free" },
    { providerID: "provider-b", id: "backup" },
  ]
  const { editor, agents } = editorWith({ reviewer: { id: "reviewer" } })
  let transform: ((editor: AgentEditor) => void) | undefined
  const routing = await registerAgentRouting({
    model: { list: async () => ({ data: models.map((model) => ({ ...model, enabled: true })) }) },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    rpc: () => ({ status: async () => { throw new Error("not configured") } }),
    agent: {
      transform: async (callback: (editor: AgentEditor) => void) => { transform = callback; return { dispose: async () => {} } },
      reload: async () => transform?.(editor as AgentEditor),
    },
  } as never, grouped)
  await routing?.reportFailure({
    providerID: "opencode", modelID: "deepseek-v4.1-flash-free", classification: "quota-exhausted",
  })
  assert.deepEqual(agents.reviewer.model, { providerID: "provider-b", id: "backup" })
  assert.deepEqual((await routing?.explain("reviewer"))?.skipped.map(({ code }) => code), ["cooldown", "cooldown", "cooldown"])
  await routing?.dispose()
})

test("automatic request guard rejects stale models but preserves manual, unbound and auxiliary requests", async () => {
  const hooks: Record<string, Array<(input: any) => Promise<void>>> = {}
  const commands: Record<string, { execute(input: { sessionID: string }): Promise<void> }> = {}
  const stored = new Map<string, unknown>()
  const session = { agent: "reviewer", model: { providerID: "provider-a", id: "primary" } }
  let unreadable = false
  const routing = await registerAgentRouting({
    model: { list: async () => ({ data: registry.map((m) => ({ providerID: m.providerID, id: m.modelID, enabled: true })) }) },
    storage: {
      get: async (key: string) => { if (unreadable && key.startsWith("routing/")) throw Error("unreadable ownership"); return stored.get(key) },
      set: async (key: string, value: unknown) => { stored.set(key, value) },
      remove: async (key: string) => { stored.delete(key) }, scan: async () => ({ entries: [] }),
    },
    rpc: () => ({ status: async () => { throw Error("unconfigured") } }),
    agent: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
    session: {
      hook: async (name: string, callback: (input: any) => Promise<void>) => {
        (hooks[name] ??= []).push(callback); return { dispose: async () => {} }
      },
      get: async () => ({ data: session }),
      switchModel: async ({ model }: { model: typeof session.model }) => { session.model = model },
    },
    command: { transform: async (callback: any) => {
      callback({ add: (command: any) => { commands[command.name] = command } }); return { dispose: async () => {} }
    } },
  } as never, config)
  const request = async (kind = "primary", agent = "reviewer", model = session.model) => {
    for (const hook of hooks["model.request"]) await hook({ sessionID: "guard", kind, agent, model })
  }
  try {
    await hooks.prompt[0]({ sessionID: "guard" })
    await routing?.reportFailure({ providerID: "provider-a", classification: "provider-outage" })
    await assert.rejects(request(), /blocked a stale or ineligible model/)
    assert.equal((await routing?.diagnoseSession("guard"))?.primaryRequestEvidence.lastObserved, "unknown")
    assert.deepEqual(session.model, { providerID: "provider-a", id: "primary" }, "guard must not change a captured model")
    await commands["qm-manual"].execute({ sessionID: "guard" })
    await request()
    await request("primary", "builder", { providerID: "host", id: "manual" })
    await commands["qm-auto"].execute({ sessionID: "guard" })
    unreadable = true
    await request("compaction")
    await assert.rejects(request(), /unreadable ownership/)
    unreadable = false
    await routing?.reportSuccess({ providerID: "provider-a", scope: "provider" })
    await request()
    await assert.rejects(request("primary", "reviewer", { providerID: "host", id: "outside" }), /blocked a stale or ineligible model/)
  } finally { await routing?.dispose() }
})

test("managed prompt refreshes quota with an unchanged registry", async () => {
  const promptConfig = parseConfig({
    plans: { local: ["provider-a/primary", "provider-b/backup"] },
    agents: { "qm-test": "local" },
    usageSources: { "provider-a": "codex" },
  })
  const snapshot = (state: "available" | "limited") => {
    const checkedAt = new Date().toISOString()
    const source = {
      authenticated: true,
      checkedAt,
      stale: false,
      error: null,
      windows: [{
        name: "weekly",
        usedPercent: state === "limited" ? 100 : 40,
        state: state === "limited" ? "rate-limited" : "ok",
        resetsAt: state === "limited" ? new Date(Date.now() + 60_000).toISOString() : null,
        ...(state === "limited" ? { resetEstimated: true } : {}),
      }],
      nextAvailableAt: state === "limited" ? new Date(Date.now() + 60_000).toISOString() : null,
      availability: state,
    }
    return {
      schemaVersion: 1,
      updatedAt: checkedAt,
      sources: { go: source, codex: source, cursor: source },
      models: { go: {} },
    }
  }
  const initialUsage = normalizeUsageSnapshot(snapshot("limited"))
  assert.equal(initialUsage.status, "ok")
  if (initialUsage.status !== "ok") return

  let nextUsage = snapshot("available")
  const usageCalls: unknown[] = []
  let modelLists = 0
  let promptHook: ((input: { sessionID: string }) => Promise<void>) | undefined
  const session: { agent: string; model: { providerID: string; id: string } } = {
    agent: "qm-test",
    model: { providerID: "provider-b", id: "backup" },
  }
  const { editor, agents } = editorWith({ "qm-test": { id: "qm-test" } })
  let transform: ((editor: AgentEditor) => void) | undefined
  const routing = await registerAgentRouting({
    model: { list: async () => {
      modelLists += 1
      return { data: [
        { providerID: "provider-a", id: "primary", enabled: true },
        { providerID: "provider-b", id: "backup", enabled: true },
      ] }
    } },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    rpc: () => ({ status: async (input: unknown) => { usageCalls.push(input); return nextUsage } }),
    agent: {
      transform: async (callback: (editor: AgentEditor) => void) => {
        transform = callback
        return { dispose: async () => {} }
      },
      reload: async () => transform?.(editor as AgentEditor),
    },
    session: {
      hook: async (name: string, callback: (input: { sessionID: string }) => Promise<void>) => {
        if (name === "prompt") promptHook = callback
        return { dispose: async () => {} }
      },
      get: async () => ({ data: session }),
      switchModel: async ({ model }: { model: { providerID: string; id: string } }) => { session.model = model },
    },
  } as never, promptConfig, initialUsage)

  assert.deepEqual(agents["qm-test"].model, { providerID: "provider-b", id: "backup" })
  const before = modelLists
  nextUsage = snapshot("available")
  const [explanation, selection] = await Promise.all([
    routing?.explain("qm-test"),
    routing?.select("qm-test"),
  ])
  assert.equal(explanation?.selected?.modelID, "primary")
  assert.equal(selection && "selected" in selection ? selection.selected?.modelID : undefined, "primary")
  assert.equal(modelLists, before + 1, "concurrent decisions share one availability refresh")
  assert.deepEqual(usageCalls, [{}], "usage status is read without forcing provider polling")

  await promptHook?.({ sessionID: "session" })

  assert.deepEqual(session.model, { providerID: "provider-a", id: "primary" })
  assert.equal(modelLists, before + 2, "registry stayed unchanged while eligibility refreshed")
  assert.deepEqual(usageCalls, [{}, {}], "prompt admission also reads cached usage without forced polling")
  await routing?.dispose()
})

test("a held exclusive model is skipped per session and does not reload the agent catalog", async () => {
  const exclusiveConfig = parseConfig({
    plans: { review: ["provider-a/primary", { id: "provider-b/backup", variant: "fast" }] },
    agents: { reviewer: "review", builder: "review" },
    exclusiveModels: ["provider-a/primary"],
  })
  const calls: string[] = []
  const { editor, agents } = editorWith({ reviewer: { id: "reviewer" }, builder: { id: "builder" } })
  let transform: ((editor: AgentEditor) => void) | undefined
  const modelRequests: Array<(input: { sessionID: string; agent: string; kind: string; model: { providerID: string; id: string } }) => Promise<void>> = []
  const request = async (input: { sessionID: string; agent: string; kind: string; model: { providerID: string; id: string } }) => {
    for (const callback of modelRequests) await callback(input)
  }
  const queued: Array<{ event: unknown; done: () => void }> = []
  let waiting: ((item: { event: unknown; done: () => void } | undefined) => void) | undefined
  let signal: AbortSignal | undefined
  const reloads = () => calls.filter((call) => call === "reload").length
  const routing = await registerAgentRouting({
    model: { list: async () => ({ data: registry.map((model) => ({ providerID: model.providerID, id: model.modelID, enabled: true })) }) },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    rpc: () => ({ status: async () => { throw new Error("not configured") } }),
    agent: {
      transform: async (callback: (editor: AgentEditor) => void) => {
        calls.push("transform")
        transform = callback
        return { dispose: async () => { calls.push("dispose") } }
      },
      reload: async () => {
        calls.push("reload")
        transform?.(editor as AgentEditor)
      },
    },
    session: {
      hook: async (name: string, callback: (input: { sessionID: string; agent: string; kind: string; model: { providerID: string; id: string } }) => Promise<void>) => {
        if (name === "model.request") modelRequests.push(callback)
        return { dispose: async () => { calls.push("dispose-hook") } }
      },
    },
    event: {
      subscribe(input: { signal?: AbortSignal }) {
        signal = input.signal
        return (async function* () {
          while (!signal?.aborted) {
            const item = queued.shift() ?? await new Promise<typeof queued[number] | undefined>((resolve) => {
              let settled = false
              const finish = (value?: typeof queued[number]) => {
                if (settled) return
                settled = true
                waiting = undefined
                resolve(value)
              }
              waiting = finish
              signal?.addEventListener("abort", () => finish(), { once: true })
            })
            if (!item || signal?.aborted) return
            yield item.event
            item.done()
          }
        })()
      },
    },
  } as never, exclusiveConfig)
  const push = (event: unknown) => new Promise<void>((done) => {
    const item = { event, done }
    if (waiting) waiting(item)
    else queued.push(item)
  })

  assert.deepEqual(agents.reviewer.model, { providerID: "provider-a", id: "primary" })
  assert.deepEqual(agents.builder.model, { providerID: "provider-a", id: "primary" })
  const before = reloads()
  const requested = { providerID: "provider-a", id: "primary" }
  await request({ sessionID: "a", agent: "reviewer", kind: "compaction", model: requested })
  await request({ sessionID: "a", agent: "reviewer", kind: "primary", model: { providerID: "provider-a", id: "other" } })
  assert.equal(reloads(), before)
  await request({ sessionID: "a", agent: "reviewer", kind: "primary", model: requested })
  assert.deepEqual(requested, { providerID: "provider-a", id: "primary" })
  assert.equal(reloads(), before)
  assert.deepEqual(agents.reviewer.model, { providerID: "provider-a", id: "primary" })
  assert.deepEqual(agents.builder.model, { providerID: "provider-a", id: "primary" })
  assert.deepEqual((await routing?.explain("builder"))?.skipped.map(({ code }) => code), ["exclusive-busy"])
  await routing?.pin("builder", primary)
  assert.equal((await routing?.explain("builder", "b"))?.selected?.modelID, "backup")
  assert.deepEqual((await routing?.explain("builder", "b"))?.skipped.map(({ code }) => code), ["exclusive-busy"])
  const pinned = reloads()
  await request({ sessionID: "a", agent: "reviewer", kind: "primary", model: requested })
  assert.equal(reloads(), pinned)
  await push({ type: "session.step.ended", data: { sessionID: "a" } })
  assert.equal(reloads(), pinned)
  await push({ type: "session.step.failed", data: { sessionID: "a" } })
  assert.equal(reloads(), pinned)
  assert.deepEqual(agents.reviewer.model, { providerID: "provider-a", id: "primary" })
  assert.deepEqual(agents.builder.model, { providerID: "provider-a", id: "primary" })
  await routing?.dispose()
  assert.ok(calls.includes("dispose-hook"))
  assert.equal(calls.at(-1), "dispose")
})

test("an exclusive model installs the request gate when no agent is bound", async () => {
  const exclusiveConfig = parseConfig({ exclusiveModels: ["ninfer/qwen3.8-27b"] })
  let hooked = false
  const routing = await registerAgentRouting({
    model: { list: async () => ({ data: [] }) },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    rpc: () => ({ status: async () => { throw new Error("not configured") } }),
    agent: {
      transform: async () => { throw new Error("no agents to transform") },
      reload: async () => {},
    },
    session: {
      hook: async () => {
        hooked = true
        return { dispose: async () => {} }
      },
    },
    event: { subscribe: () => (async function* () {})() },
  } as never, exclusiveConfig)
  assert.equal(hooked, true)
  await routing?.dispose()
})

test("each new prompt chooses for that session and chooses again after the turn", async () => {
  const promptConfig = parseConfig({
    plans: { review: ["provider-a/primary", { id: "provider-b/backup", variant: "fast" }, { id: "provider-a/primary", variant: "reasoning" }] },
    agents: { reviewer: "review" },
    exclusiveModels: ["provider-a/primary"],
  })
  const sessions: Record<string, { agent: string; model: { providerID: string; id: string; variant?: string } }> = {
    a: { agent: "reviewer", model: { providerID: "provider-a", id: "primary" } },
    b: { agent: "reviewer", model: { providerID: "provider-a", id: "primary" } },
    c: { agent: "reviewer", model: { providerID: "user", id: "picked" } },
    d: { agent: "unbound", model: { providerID: "provider-a", id: "primary" } },
    e: { agent: "reviewer", model: { providerID: "provider-a", id: "primary" } },
  }
  const switches: string[] = []
  const commands: Record<string, { execute(input: { sessionID: string }): Promise<void> }> = {}
  const stored = new Map<string, unknown>()
  const hooks: Record<string, Array<(input: {
    sessionID: string
    kind?: string
    agent?: string
    model?: { providerID: string; id: string }
    decision?: { retry: boolean; delay?: number }
    error?: { status?: number }
  }) => Promise<void>>> = {}
  const queued: Array<{ event: unknown; done: () => void }> = []
  let waiting: ((item: { event: unknown; done: () => void } | undefined) => void) | undefined
  let signal: AbortSignal | undefined
  const routing = await registerAgentRouting({
    model: { list: async () => ({ data: registry.map((model) => ({ providerID: model.providerID, id: model.modelID, enabled: true })) }) },
    storage: {
      get: async (key: string) => stored.get(key), set: async (key: string, value: unknown) => { stored.set(key, value) },
      remove: async (key: string) => { stored.delete(key) }, scan: async () => ({ entries: [] }),
    },
    rpc: () => ({ status: async () => { throw new Error("not configured") } }),
    agent: {
      transform: async () => ({ dispose: async () => {} }),
      reload: async () => {},
    },
    session: {
      hook: async (name: string, callback: (input: { sessionID: string }) => Promise<void>) => {
        hooks[name] ??= []
        hooks[name].push(callback)
        return { dispose: async () => {} }
      },
      get: async (input: { sessionID: string }) => ({ data: sessions[input.sessionID] }),
      switchModel: async (input: { sessionID: string; model: { providerID: string; id: string; variant?: string } }) => {
        switches.push(input.sessionID)
        sessions[input.sessionID].model = input.model
      },
    },
    command: {
      transform: async (callback: (editor: { add(command: { name: string; execute(input: { sessionID: string }): Promise<void> }): void }) => void) => {
        callback({ add: (command) => { commands[command.name] = command } })
        return { dispose: async () => {} }
      },
    },
    event: {
      subscribe(input: { signal?: AbortSignal }) {
        signal = input.signal
        return (async function* () {
          while (!signal?.aborted) {
            const item = queued.shift() ?? await new Promise<typeof queued[number] | undefined>((resolve) => {
              let settled = false
              const finish = (value?: typeof queued[number]) => {
                if (settled) return
                settled = true
                waiting = undefined
                resolve(value)
              }
              waiting = finish
              signal?.addEventListener("abort", () => finish(), { once: true })
            })
            if (!item || signal?.aborted) return
            yield item.event
            item.done()
          }
        })()
      },
    },
  } as never, promptConfig)
  const prompt = (sessionID: string) => hooks.prompt[0]({ sessionID })
  const push = (event: unknown) => new Promise<void>((done) => {
    const item = { event: { created: Date.now(), ...(event as object) }, done: () => setTimeout(done, 2) }
    if (waiting) waiting(item)
    else queued.push(item)
  })

  await prompt("a")
  assert.deepEqual(switches, [])
  assert.equal((await routing?.explain("reviewer", "b"))?.selected?.modelID, "backup")
  await prompt("b")
  assert.deepEqual(sessions.b.model, { providerID: "provider-b", id: "backup", variant: "fast" })
  await commands["qm-manual"].execute({ sessionID: "c" })
  await prompt("c")
  assert.equal(sessions.c.model.id, "picked")
  assert.deepEqual(switches, ["b"])
  for (const callback of hooks["model.request"]) {
    await callback({ sessionID: "a", kind: "title", agent: "reviewer", model: { providerID: "provider-a", id: "primary" } })
  }
  await hooks.retry[0]({
    sessionID: "a", agent: "reviewer", model: { providerID: "provider-a", id: "primary" },
    decision: { retry: true, delay: 500 }, error: { status: 429 },
  })
  assert.deepEqual(sessions.a.model, { providerID: "provider-a", id: "primary" }, "auxiliary requests must not route retries")
  for (const callback of hooks["model.request"]) {
    await callback({ sessionID: "c", kind: "primary", agent: "reviewer", model: { providerID: "user", id: "picked" } })
    await callback({ sessionID: "d", kind: "primary", agent: "unbound", model: { providerID: "user", id: "picked" } })
  }
  await hooks.retry[0]({
    sessionID: "c", agent: "reviewer", model: { providerID: "user", id: "picked" },
    decision: { retry: true, delay: 500 }, error: { status: 429 },
  })
  await hooks.retry[0]({
    sessionID: "d", agent: "unbound", model: { providerID: "user", id: "picked" },
    decision: { retry: true, delay: 500 }, error: { status: 429 },
  })
  assert.deepEqual(sessions.c.model, { providerID: "user", id: "picked" }, "out-of-plan manual models must not route retries")
  assert.deepEqual(sessions.d.model, { providerID: "provider-a", id: "primary" }, "unbound agents must not route retries")
  for (const callback of hooks["model.request"]) {
    await callback({ sessionID: "a", kind: "primary", agent: "reviewer", model: { providerID: "provider-a", id: "primary" } })
  }
  await hooks.retry[0]({
    sessionID: "a", agent: "reviewer", model: { providerID: "provider-a", id: "primary" },
    decision: { retry: true, delay: 500 }, error: { status: 429 },
  })
  assert.deepEqual(sessions.a.model, { providerID: "provider-b", id: "backup", variant: "fast" })
  assert.deepEqual(switches, ["b", "a"])
  for (const callback of hooks["model.request"]) {
    await callback({ sessionID: "a", kind: "primary", agent: "reviewer", model: { providerID: "provider-b", id: "backup" } })
  }
  await hooks.retry[0]({
    sessionID: "a", agent: "reviewer", model: { providerID: "provider-b", id: "backup" },
    decision: { retry: true, delay: 500 }, error: { status: 429 },
  })
  assert.deepEqual(switches, ["b", "a"], "a model already attempted in this execution is not selected again")
  sessions.a.model = { providerID: "provider-b", id: "backup", variant: "fast" }
  await prompt("a")
  assert.deepEqual(switches, ["b", "a"])
  await push({ type: "session.step.ended", data: { sessionID: "a" } })
  await prompt("b")
  assert.equal(sessions.b.model.id, "backup")
  await push({ type: "session.execution.succeeded", data: { sessionID: "a" } })
  await prompt("b")
  assert.equal(sessions.b.model.id, "backup", "the retry cooldown keeps the failed primary out of the next selection")
  await routing?.reportSuccess({ providerID: "provider-a", scope: "model", modelID: "primary" })
  const requestE = async (model: { providerID: string; id: string; variant?: string }) => {
    for (const callback of hooks["model.request"]) {
      await callback({ sessionID: "e", kind: "primary", agent: "reviewer", model })
    }
  }
  await requestE({ providerID: "provider-a", id: "primary" })
  await push({ type: "session.execution.succeeded", data: { sessionID: "e" } })
  await commands["qm-manual"].execute({ sessionID: "e" })
  sessions.e.model = { providerID: "provider-a", id: "primary", variant: "reasoning" }
  await prompt("e")
  assert.deepEqual(sessions.e.model, { providerID: "provider-a", id: "primary", variant: "reasoning" }, "an explicit in-plan variant survives its first assignment boundary")
  await requestE(sessions.e.model)
  await push({ type: "session.execution.succeeded", data: { sessionID: "e" } })
  await prompt("e")
  assert.deepEqual(sessions.e.model, { providerID: "provider-a", id: "primary", variant: "reasoning" }, "the explicit variant remains sticky after being used")
  assert.deepEqual(switches, ["b", "a"], "manual opt-out must not trigger a model switch")
  await hooks.retry[0]({
    sessionID: "e", agent: "reviewer", model: sessions.e.model,
    decision: { retry: true, delay: 500 }, error: { status: 429 },
  })
  assert.deepEqual(sessions.e.model, { providerID: "provider-a", id: "primary", variant: "reasoning" }, "manual in-plan choices must not route retries")
  await commands["qm-auto"].execute({ sessionID: "e" })
  await prompt("e")
  assert.deepEqual(sessions.e.model, { providerID: "provider-a", id: "primary" }, "resuming automatic routing removes the manual variant")
  await requestE(sessions.e.model)
  const beforeBusyPrompt = [...switches]
  await prompt("e")
  assert.deepEqual(switches, beforeBusyPrompt, "a prompt admitted while primary execution is active must not switch its model")
  await push({ type: "session.execution.interrupted", data: { sessionID: "e" } })
  await prompt("a")
  assert.deepEqual(sessions.a.model, { providerID: "provider-a", id: "primary" }, "cancelling the owner releases its exclusive slot for another idle session")
  await hooks["model.request"][0]({ sessionID: "a", kind: "primary", agent: "reviewer", model: sessions.a.model })
  const occurredAt = Date.now()
  const terminal = { type: "session.execution.failed", created: occurredAt, data: { sessionID: "a", error: { type: "provider.quota", status: 402 } } }
  const beforeTerminal = stored.get("availability/cooldowns-v1")
  await push({ ...terminal, created: occurredAt + 60000 })
  assert.deepEqual(stored.get("availability/cooldowns-v1"), beforeTerminal, "future event timestamps cannot create a cooldown")
  // A finish clears request correlation even when its timestamp is unusable.
  await hooks["model.request"][0]({ sessionID: "a", kind: "primary", agent: "reviewer", model: sessions.a.model })
  await push({ ...terminal, created: occurredAt - 60000 })
  assert.deepEqual(stored.get("availability/cooldowns-v1"), beforeTerminal, "an old execution cannot be attributed to a newer request")
  await hooks["model.request"][0]({ sessionID: "a", kind: "primary", agent: "reviewer", model: sessions.a.model })
  terminal.created = Date.now()
  await push(terminal)
  assert.equal(sessions.a.model.id, "primary", "terminal observation must not resend or switch")
  const persisted = stored.get("availability/cooldowns-v1")
  assert.ok(JSON.stringify(persisted).includes(String(terminal.created + 300000)), "expiry uses original terminal time")
  await push(terminal)
  assert.deepEqual(stored.get("availability/cooldowns-v1"), persisted, "duplicate terminal delivery must not renew expiry")
  await prompt("a")
  assert.deepEqual(sessions.a.model, { providerID: "provider-b", id: "backup", variant: "fast" }, "next explicit prompt avoids terminal quota failure without a retry hook")
  await routing?.reportSuccess({ providerID: "provider-a", scope: "model", modelID: "primary" })
  sessions.f = { agent: "reviewer", model: { providerID: "provider-a", id: "primary" } }
  await hooks["model.request"][0]({ sessionID: "f", kind: "compaction", agent: "reviewer", model: sessions.f.model })
  const compactedAt = Date.now()
  // Cleanup and a user agent/model change happen before delayed failure delivery.
  await push({ type: "session.execution.succeeded", data: { sessionID: "f" } })
  sessions.f = { agent: "unbound", model: { providerID: "user", id: "picked" } }
  const compactionFailure = { type: "session.compaction.failed", created: compactedAt, data: { sessionID: "f", error: { type: "provider.quota", status: 402 } } }
  await push(compactionFailure)
  const afterCompaction = stored.get("availability/cooldowns-v1")
  assert.ok(JSON.stringify(afterCompaction).includes(String(compactedAt + 300000)))
  const diagnostic = await routing?.diagnoseSession("f")
  assert.equal(diagnostic?.lastFailureObservation?.kind, "compaction")
  assert.equal(diagnostic?.lastFailureObservation?.model?.modelID, "primary")
  assert.equal(diagnostic?.lastFailureObservation?.deadline, compactedAt + 300000)
  assert.equal(sessions.f.model.id, "picked", "late compaction failure never switches current manual/unbound work")
  await push(compactionFailure)
  assert.deepEqual(stored.get("availability/cooldowns-v1"), afterCompaction)
  sessions.f = { agent: "reviewer", model: { providerID: "provider-a", id: "primary" } }
  await prompt("f")
  assert.equal(sessions.f.model.id, "backup", "compaction before primary supplies cooldown for the next automatic prompt")
  for (const sessionID of ["c", "d"]) {
    const prior = stored.get("availability/cooldowns-v1")
    await hooks["model.request"][0]({ sessionID, kind: "compaction", agent: sessions[sessionID].agent, model: sessions[sessionID].model })
    await push({ type: "session.compaction.failed", created: Date.now(), data: { sessionID, error: { status: 429 } } })
    assert.deepEqual(stored.get("availability/cooldowns-v1"), prior, "manual and unbound compaction is unmanaged")
  }
  await routing?.reportSuccess({ providerID: "provider-a", scope: "model", modelID: "primary" })
  await routing?.reportSuccess({ providerID: "provider-b", scope: "model", modelID: "backup" })
  sessions.g = { agent: "reviewer", model: { providerID: "provider-a", id: "primary" } }
  for (const callback of hooks["model.request"]) {
    await callback({ sessionID: "g", kind: "primary", agent: "reviewer", model: sessions.g.model })
    await callback({ sessionID: "g", kind: "compaction", agent: "reviewer", model: { providerID: "provider-b", id: "backup" } })
  }
  await push({ type: "session.compaction.failed", created: Date.now(), data: { sessionID: "g", error: { type: "unknown", message: "Rate limit exceeded. Please try again later." } } })
  const separate = stored.get("availability/cooldowns-v1")
  assert.ok(JSON.stringify(separate).includes("backup"), "text-only compaction failure cools its separate model")
  assert.ok(!JSON.stringify(separate).includes("primary"), "compaction does not cool the unrelated primary")
  assert.equal((await routing?.explain("reviewer", "a"))?.selected?.modelID, undefined, "compaction failure must not release the active primary exclusive lease")
  await push({ type: "session.execution.succeeded", data: { sessionID: "g" } })
  await routing?.reportSuccess({ providerID: "provider-a", scope: "model", modelID: "primary" })
  await push(compactionFailure)
  assert.ok(!JSON.stringify(stored.get("availability/cooldowns-v1")).includes("primary"), "duplicates cannot reinstate a cooldown cleared by success")
  sessions.h = { agent: "reviewer", model: { providerID: "provider-a", id: "primary" } }
  await hooks["model.request"][0]({ sessionID: "h", kind: "compaction", agent: "reviewer", model: sessions.h.model })
  const expiredAt = Date.now()
  const clock = Date.now
  const beforeExpired = stored.get("availability/cooldowns-v1")
  try {
    Date.now = () => expiredAt + 300001
    await push({ type: "session.compaction.failed", created: expiredAt, data: { sessionID: "h", error: { status: 429 } } })
    assert.deepEqual(stored.get("availability/cooldowns-v1"), beforeExpired, "delayed expired evidence creates no fresh cooldown")
    assert.equal((await routing?.diagnoseSession("h"))?.lastFailureObservation?.outcome, "expired")
  } finally { Date.now = clock }
  // A free-allowance failure is nonretryable, so the terminal event is the only place its reset is seen.
  await routing?.reportSuccess({ providerID: "provider-a", scope: "model", modelID: "primary" })
  await routing?.reportSuccess({ providerID: "provider-b", scope: "model", modelID: "backup" })
  await hooks["model.request"][0]({ sessionID: "a", kind: "primary", agent: "reviewer", model: sessions.a.model })
  const freeAt = Date.now()
  await push({ type: "session.execution.failed", created: freeAt, data: { sessionID: "a", error: { type: "provider.free-limit", status: 429, retryAfterMs: 3_600_000 } } })
  const freePersisted = JSON.stringify(stored.get("availability/cooldowns-v1"))
  assert.ok(freePersisted.includes(String(freeAt + 3_600_000)), "the cooldown must reach the reset the error stated")
  assert.ok(!freePersisted.includes(String(freeAt + 300000)), "the configured floor must not cap the stated reset")
  await routing?.dispose()
})

test("ambiguous auxiliary retries do not switch the primary model", async () => {
  const regressionConfig = parseConfig({
    plans: { review: ["provider-a/primary", { id: "provider-b/backup", variant: "fast" }] },
    agents: { reviewer: "review" },
  })
  const session: { agent: string; model: { providerID: string; id: string; variant?: string } } = {
    agent: "reviewer", model: { providerID: "provider-a", id: "primary" },
  }
  const switches: Array<{ providerID: string; id: string; variant?: string }> = []
  const stored = new Map<string, unknown>()
  const hooks: Record<string, Array<(input: any) => Promise<void>>> = {}
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (message?: unknown) => { warnings.push(String(message)) }
  const routing = await registerAgentRouting({
    model: { list: async () => ({ data: registry.map((model) => ({ providerID: model.providerID, id: model.modelID, enabled: true })) }) },
    storage: {
      get: async (key: string) => stored.get(key), set: async (key: string, value: unknown) => { stored.set(key, value) },
      remove: async (key: string) => { stored.delete(key) }, scan: async () => ({ entries: [] }),
    },
    rpc: () => ({ status: async () => { throw new Error("not configured") } }),
    agent: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
    session: {
      hook: async (name: string, callback: (input: any) => Promise<void>) => {
        hooks[name] ??= []
        hooks[name].push(callback)
        return { dispose: async () => {} }
      },
      get: async () => ({ data: session }),
      switchModel: async (input: { model: { providerID: string; id: string; variant?: string } }) => {
        switches.push(input.model)
        session.model = input.model
      },
    },
    event: { subscribe: () => (async function* () {})() },
  } as never, regressionConfig)
  const request = async (kind: string, model: { providerID: string; id: string; variant?: string }) => {
    for (const callback of hooks["model.request"]) {
      await callback({ sessionID: "a", kind, agent: "reviewer", model })
    }
  }
  const retry = (model: { providerID: string; id: string; variant?: string }, event: { decision: { retry: boolean }; error: unknown }) =>
    hooks.retry[0]({ sessionID: "a", agent: "reviewer", model, ...event })
  const unclassified = () => warnings.filter((warning) => warning.includes("unclassified retried failure"))
  try {
    await request("primary", { providerID: "provider-a", id: "primary" })
    await request("title", { providerID: "provider-a", id: "primary" })
    await retry({ providerID: "provider-a", id: "primary" }, {
      decision: { retry: true }, error: { status: 429 },
    })
    assert.deepEqual(switches, [], "retry has no request kind: do not assume the auxiliary failure is primary")
    await request("primary", { providerID: "provider-a", id: "primary" })
    await retry({ providerID: "provider-a", id: "primary" }, {
      decision: { retry: true },
      error: { type: "unknown", message: "Rate limit exceeded. Please try again later." },
    })
    assert.deepEqual(session.model, { providerID: "provider-b", id: "backup", variant: "fast" })
    assert.deepEqual(switches, [{ providerID: "provider-b", id: "backup", variant: "fast" }])
    assert.deepEqual(unclassified(), [])
    await request("primary", { providerID: "provider-b", id: "backup", variant: "fast" })
    await retry({ providerID: "provider-b", id: "backup", variant: "fast" }, { decision: { retry: true }, error: { type: "provider.weird" } })
    assert.equal(unclassified().length, 1, "a retried failure Quartermaster cannot classify is reported once")
    await retry({ providerID: "provider-b", id: "backup", variant: "fast" }, {
      decision: { retry: false },
      error: { type: "unknown", message: "Rate limit exceeded. Please try again later." },
    })
    assert.deepEqual(switches, [{ providerID: "provider-b", id: "backup", variant: "fast" }], "a host that does not retry is never switched")
    assert.equal(unclassified().length, 1)
  } finally {
    console.warn = originalWarn
    await routing?.dispose()
  }
})

test("adopting project options revalidates and persists project-scoped pins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qm-routing-pins-"))
  const values = new Map<string, unknown>([["pins/v1/project-z", {
    reviewer: { providerID: "provider-b", modelID: "backup", variant: "fast" },
  }]])
  const hooks: Record<string, Array<(input: any) => Promise<void>>> = {}
  let routing: Awaited<ReturnType<typeof registerAgentRouting>>
  try {
    await writeFile(join(directory, "opencode.json"), JSON.stringify({
      plugins: [{ package: "quartermaster" }],
    }))
    await writeFile(join(directory, "quartermaster.jsonc"), JSON.stringify({
      plans: { review: ["provider-a/primary"] }, agents: { reviewer: "review" },
    }))
    const baseConfig = parseConfig({
      plans: { review: ["provider-a/primary", { id: "provider-b/backup", variant: "fast" }] },
      agents: { reviewer: "review" },
    })
    routing = await registerAgentRouting({
      location: { directory, project: { id: "project-z" } },
      model: { list: async () => ({ data: [
        { providerID: "provider-a", id: "primary", enabled: true },
        { providerID: "provider-b", id: "backup", enabled: true },
      ] }) },
      storage: {
        get: async (key: string) => values.get(key),
        set: async (key: string, value: unknown) => { values.set(key, value) },
        remove: async (key: string) => { values.delete(key) },
        scan: async () => ({ entries: [] }),
      },
      rpc: () => ({ status: async () => { throw new Error("not configured") } }),
      agent: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
      session: {
        hook: async (name: string, callback: (input: any) => Promise<void>) => {
          hooks[name] ??= []
          hooks[name].push(callback)
          return { dispose: async () => {} }
        },
        get: async () => ({ data: { agent: "reviewer", model: { providerID: "provider-a", id: "primary" } } }),
        switchModel: async () => {},
      },
      event: { subscribe: () => (async function* () {})() },
    } as never, baseConfig, undefined, undefined, fixtureConfiguration)

    await hooks.prompt[0]({ sessionID: "session" })
    assert.deepEqual(baseConfig.plans.review, [{ providerID: "provider-a", modelID: "primary" }])
    assert.deepEqual(values.get("pins/v1/project-z"), {}, "removed project-plan pins are persisted as cleared")
    assert.deepEqual(values.get("pins/v1"), undefined, "project-scoped pins do not write the legacy shared key")
  } finally {
    await routing?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test("structured unsafe failures never switch models even when the host retry hook permits retry", async () => {
  const retryConfig = parseConfig({
    plans: { review: ["provider-a/primary", "provider-b/backup"] },
    agents: { reviewer: "review" },
  })
  const hooks: Record<string, Array<(input: any) => Promise<void>>> = {}
  const session = { agent: "reviewer", model: { providerID: "provider-a", id: "primary" } }
  const switches: unknown[] = []
  const routing = await registerAgentRouting({
    model: { list: async () => ({ data: [
      { providerID: "provider-a", id: "primary", enabled: true },
      { providerID: "provider-b", id: "backup", enabled: true },
    ] }) },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    rpc: () => ({ status: async () => { throw new Error("not configured") } }),
    agent: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
    session: {
      hook: async (name: string, callback: (input: any) => Promise<void>) => {
        hooks[name] ??= []
        hooks[name].push(callback)
        return { dispose: async () => {} }
      },
      get: async () => ({ data: session }),
      switchModel: async (input: unknown) => { switches.push(input) },
    },
  } as never, retryConfig)

  const unsafe = [
    { type: "cancelled" },
    { type: "permission.rejected" },
    { type: "provider.quota", status: 402 },
    { type: "provider.auth", status: 401 },
    { type: "provider.invalid-request", status: 404 },
    { type: "provider.invalid-request", status: 413 },
    { type: "provider.no-route" },
    { type: "provider.content-filter" },
    { type: "provider.unsupported-operation" },
    { type: "provider.invalid-output" },
    { type: "provider.timeout" },
    { type: "provider.unknown" },
  ]
  for (const error of unsafe) {
    // Independent failures: a prior model-outage must not block the next test dispatch.
    await routing?.reportSuccess({ providerID: "provider-a", modelID: "primary", scope: "model" })
    await hooks["model.request"][0]({ sessionID: "s", kind: "primary", agent: "reviewer", model: session.model })
    const event = {
      sessionID: "s", agent: "reviewer", model: session.model,
      decision: { retry: true, delay: 250 }, error,
    }
    await hooks.retry[0](event)
    assert.deepEqual(event.decision, { retry: true, delay: 250 })
    assert.deepEqual(session.model, { providerID: "provider-a", id: "primary" })
  }
  assert.deepEqual(switches, [])
  await routing?.dispose()
})

test("retry fallback attempts each model once, rolls back failed switches, and reserves exclusive fallbacks", async () => {
  const retryConfig = parseConfig({
    plans: { review: ["provider-a/primary", "provider-b/backup"] },
    agents: { reviewer: "review" },
    exclusiveModels: ["provider-b/backup"],
  })
  const sessions = Object.fromEntries(["a", "b", "c"].map((sessionID) => [sessionID, {
    agent: "reviewer", model: { providerID: "provider-a", id: "primary" },
  }])) as Record<string, { agent: string; model: { providerID: string; id: string; variant?: string } }>
  const hooks: Record<string, Array<(input: any) => Promise<void>>> = {}
  const queued: Array<{ event: unknown; done: () => void }> = []
  let waiting: ((item: { event: unknown; done: () => void } | undefined) => void) | undefined
  let signal: AbortSignal | undefined
  let failSession = "a"
  const switches: string[] = []
  const routing = await registerAgentRouting({
    model: { list: async () => ({ data: ["provider-a/primary", "provider-b/backup", "provider-c/other"].map((model) => {
      const [providerID, id] = model.split("/")
      return { providerID, id, enabled: true }
    }) }) },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    rpc: () => ({ status: async () => { throw new Error("not configured") } }),
    agent: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
    session: {
      hook: async (name: string, callback: (input: any) => Promise<void>) => {
        hooks[name] ??= []
        hooks[name].push(callback)
        return { dispose: async () => {} }
      },
      get: async ({ sessionID }: { sessionID: string }) => ({ data: sessions[sessionID] }),
      switchModel: async ({ sessionID, model }: { sessionID: string; model: { providerID: string; id: string } }) => {
        switches.push(sessionID)
        if (failSession === sessionID) {
          failSession = ""
          throw new Error("injected switch failure")
        }
        sessions[sessionID].model = model
      },
    },
    event: {
      subscribe({ signal: nextSignal }: { signal: AbortSignal }) {
        signal = nextSignal
        return (async function* () {
          while (!signal?.aborted) {
            const item = queued.shift() ?? await new Promise<typeof queued[number] | undefined>((resolve) => {
              waiting = resolve
              signal?.addEventListener("abort", () => resolve(undefined), { once: true })
            })
            if (!item || signal?.aborted) return
            yield item.event
            item.done()
          }
        })()
      },
    },
  } as never, retryConfig)
  assert.equal(hooks.retry.length, 1, "routing registers one retry handler")
  const request = async (sessionID: string) => {
    // These retry scenarios start with a reachable primary, not a stale queued dispatch.
    await routing?.reportSuccess({ providerID: "provider-a", scope: "provider" })
    await routing?.reportSuccess({ providerID: "provider-a", modelID: "primary", scope: "model" })
    for (const callback of hooks["model.request"]) {
      await callback({ sessionID, kind: "primary", agent: "reviewer", model: { providerID: "provider-a", id: "primary" } })
    }
  }
  const retry = (sessionID: string, decision = true, error: { type?: string; status?: number } = { status: decision ? 429 : 499 }) => {
    const event = {
      sessionID, agent: "reviewer", model: { providerID: "provider-a", id: "primary" },
      decision: { retry: decision, delay: 100 }, error,
    }
    return hooks.retry[0](event).then(() => event)
  }
  const push = (event: unknown) => new Promise<void>((done) => {
    const item = { event, done }
    if (waiting) waiting(item)
    else queued.push(item)
  })

  await request("a")
  const denied = await retry("a", false, { type: "provider.internal", status: 503 })
  assert.deepEqual(denied.decision, { retry: false, delay: 100 }, "routing preserves the retry veto observed at its hook")
  assert.deepEqual(switches, [], "a later hook observing a veto must not route or reserve")
  const failedSwitch = await retry("a")
  assert.deepEqual(failedSwitch.decision, { retry: true, delay: 100 }, "switch failure must preserve the host retry decision and delay")
  assert.deepEqual(sessions.a.model, { providerID: "provider-a", id: "primary" })
  await routing?.pin("reviewer", { providerID: "provider-b", modelID: "backup" })
  const pinnedAttempt = await retry("a")
  assert.deepEqual(pinnedAttempt.decision, { retry: true, delay: 100 })
  assert.deepEqual(switches, ["a"], "a pin cannot reselect a model already attempted in this execution")
  await request("b")
  await retry("b")
  assert.deepEqual(sessions.b.model, { providerID: "provider-b", id: "backup" }, "failed switch must release its reservation")
  await request("c")
  await retry("c")
  assert.deepEqual(sessions.c.model, { providerID: "provider-a", id: "primary" }, "another session cannot take a reserved exclusive fallback")
  await push({ type: "session.execution.succeeded", data: { sessionID: "b" } })
  await retry("c")
  assert.deepEqual(sessions.c.model, { providerID: "provider-b", id: "backup" }, "finishing the owner releases the transferred lease")
  retryConfig.plans.review.push({ providerID: "provider-c", modelID: "other" })
  await request("a")
  await retry("a")
  assert.deepEqual(sessions.a.model, { providerID: "provider-c", id: "other" }, "an in-flight retry sees the updated plan after excluding attempted models")
  await routing?.dispose()
})

test("bound agents route automatically by default and support manual release", async () => {
  const hooks: Record<string, ((input: { sessionID: string }) => Promise<void>)[]> = {}
  const commands: Record<string, { execute(input: { sessionID: string }): Promise<void> }> = {}
  const stored = new Map<string, unknown>()
  const events: Array<{ event: unknown; done: () => void }> = []
  let waiting: ((item: typeof events[number] | undefined) => void) | undefined
  const session: { agent: string; model: { providerID: string; id: string; variant?: string } } = {
    agent: "reviewer",
    model: { providerID: "composer", id: "default" },
  }
  const { editor } = editorWith({ reviewer: { id: "reviewer" } })
  const routing = await registerAgentRouting({
    model: { list: async () => ({ data: [
      { providerID: "provider-a", id: "primary", enabled: true },
      { providerID: "provider-b", id: "backup", enabled: true },
    ] }) },
    storage: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: unknown) => { stored.set(key, value) },
      remove: async (key: string) => { stored.delete(key) },
      scan: async () => ({ entries: [] }),
    },
    rpc: () => ({ status: async () => { throw new Error("not configured") } }),
    agent: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
    session: {
      hook: async (name: string, callback: (input: { sessionID: string }) => Promise<void>) => {
        hooks[name] ??= []
        hooks[name].push(callback)
        return { dispose: async () => {} }
      },
      get: async () => ({ data: session }),
      switchModel: async ({ model }: { model: { providerID: string; id: string; variant?: string } }) => { session.model = model },
    },
    command: {
      transform: async (callback: (editor: { add(command: { name: string; execute(input: { sessionID: string }): Promise<void> }): void }) => void) => {
        callback({ add: (command) => { commands[command.name] = command } })
        return { dispose: async () => {} }
      },
    },
    event: {
      subscribe({ signal }: { signal: AbortSignal }) {
        return (async function* () {
          while (!signal.aborted) {
            const item = events.shift() ?? await new Promise<typeof events[number] | undefined>((resolve) => {
              waiting = resolve
              signal.addEventListener("abort", () => resolve(undefined), { once: true })
            })
            if (!item || signal.aborted) return
            yield item.event
            item.done()
          }
        })()
      },
    },
    location: { directory: "project-a" },
  } as never, config)

  await hooks.prompt[0]({ sessionID: "session" })
  assert.deepEqual(session.model, { providerID: "provider-a", id: "primary" }, "bound agent switches before prompt hook completes by default")
  for (const callback of hooks["model.request"]) {
    await callback({ sessionID: "session", kind: "primary", agent: "reviewer", model: session.model } as never)
  }
  await new Promise<void>((done) => {
    const item = { event: { type: "session.execution.succeeded", data: { sessionID: "session" } }, done }
    if (waiting) { const resume = waiting; waiting = undefined; resume(item) }
    else events.push(item)
  })
  session.model = { providerID: "provider-b", id: "backup", variant: "fast" }
  await hooks.prompt[0]({ sessionID: "session" })
  assert.deepEqual(session.model, { providerID: "provider-a", id: "primary" }, "an in-plan picker choice is not a manual opt-out")
  session.model = { providerID: "provider-a", id: "primary", variant: "reasoning" }
  await hooks.prompt[0]({ sessionID: "session" })
  assert.deepEqual(session.model, { providerID: "provider-a", id: "primary" }, "variant provenance is not inferred from model IDs")

  session.model = { providerID: "composer", id: "manual" }
  await commands["qm-manual"].execute({ sessionID: "session" })
  await hooks.prompt[0]({ sessionID: "session" })
  assert.deepEqual(session.model, { providerID: "composer", id: "manual" }, "manual release preserves an out-of-plan choice")
  session.model = { providerID: "provider-a", id: "primary", variant: "reasoning" }
  await hooks.prompt[0]({ sessionID: "session" })
  assert.deepEqual(session.model, { providerID: "provider-a", id: "primary", variant: "reasoning" }, "manual release preserves a variant-only choice")
  await commands["qm-auto"].execute({ sessionID: "session" })
  await hooks.prompt[0]({ sessionID: "session" })
  assert.deepEqual(session.model, { providerID: "provider-a", id: "primary" }, "explicitly returning to automatic routing reapplies the plan")
  session.agent = "unbound"
  session.model = { providerID: "composer", id: "manual" }
  await hooks.prompt[0]({ sessionID: "session" })
  assert.equal(stored.size, 0, "changing agents clears the old ownership record")
  session.agent = "reviewer"
  await commands["qm-auto"].execute({ sessionID: "session" })
  await new Promise<void>((done) => {
    const item = { event: { type: "session.deleted", data: { sessionID: "session" } }, done }
    if (waiting) { const resume = waiting; waiting = undefined; resume(item) }
    else events.push(item)
  })
  assert.equal(stored.size, 0, "session deletion clears persistent ownership")
  await routing?.dispose()
})

test("default automatic admission rejects a failed switch and releases its exclusive reservation", async () => {
  const admissionConfig = parseConfig({
    plans: { review: ["provider-a/primary", "provider-b/backup"] },
    agents: { reviewer: "review" },
    exclusiveModels: ["provider-a/primary"],
  })
  const hooks: Array<(input: { sessionID: string }) => Promise<void>> = []
  const stored = new Map<string, unknown>()
  const sessions = new Map([
    ["failed", { agent: "reviewer", model: { providerID: "composer", id: "default" } }],
    ["noop", { agent: "reviewer", model: { providerID: "composer", id: "default" } }],
    ["unread", { agent: "reviewer", model: { providerID: "composer", id: "default" } }],
    ["other", { agent: "builder", model: { providerID: "composer", id: "default" } }],
    ["blank", { model: { providerID: "composer", id: "default" } }],
    ["confirm-unread", { agent: "reviewer", model: { providerID: "composer", id: "default" } }],
    ["next", { agent: "reviewer", model: { providerID: "composer", id: "default" } }],
  ])
  const routing = await registerAgentRouting({
    model: { list: async () => ({ data: [
      { providerID: "provider-a", id: "primary", enabled: true },
      { providerID: "provider-b", id: "backup", enabled: true },
    ] }) },
    storage: {
      get: async (key: string) => stored.get(key), set: async (key: string, value: unknown) => { stored.set(key, value) },
      remove: async (key: string) => { stored.delete(key) }, scan: async () => ({ entries: [] }),
    },
    rpc: () => ({ status: async () => { throw new Error("not configured") } }),
    agent: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
    session: {
      hook: async (name: string, callback: (input: { sessionID: string }) => Promise<void>) => {
        if (name === "prompt") hooks.push(callback)
        return { dispose: async () => {} }
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions.get(sessionID)
        if (sessionID === "unread" || (sessionID === "confirm-unread" && session?.model.id === "primary")) throw new Error("private host error")
        return { data: session }
      },
      switchModel: async ({ sessionID, model }: { sessionID: string; model: { providerID: string; id: string } }) => {
        if (sessionID === "failed") throw new Error("switch failed")
        if (sessionID === "noop") return
        sessions.get(sessionID)!.model = model
      },
    },
    location: { directory: "project-a" },
  } as never, admissionConfig)

  await assert.rejects(hooks[0]({ sessionID: "failed" }), /could not confirm its model switch/)
  await assert.rejects(hooks[0]({ sessionID: "noop" }), /could not confirm its model switch/)
  await hooks[0]({ sessionID: "unread" })
  await hooks[0]({ sessionID: "other" })
  await hooks[0]({ sessionID: "blank" })
  assert.deepEqual(sessions.get("unread")?.model, { providerID: "composer", id: "default" }, "an unreadable session is left untouched")
  assert.deepEqual(sessions.get("other")?.model, { providerID: "composer", id: "default" }, "an agent without a Quartermaster binding is left untouched")
  assert.deepEqual(sessions.get("blank")?.model, { providerID: "composer", id: "default" }, "a session with no agent is left untouched")
  await assert.rejects(hooks[0]({ sessionID: "confirm-unread" }), /could not confirm its model switch/)
  await hooks[0]({ sessionID: "next" })
  assert.deepEqual(sessions.get("next")?.model, { providerID: "provider-a", id: "primary" }, "failed admission releases the exclusive reservation")
  await routing?.dispose()
})

test("manual opt-out survives reload and stays isolated by project and session", async () => {
  const ownerConfig = parseConfig({ plans: { review: ["provider-a/primary"] }, agents: { reviewer: "review" } })
  const stored = new Map<string, unknown>()
  const sessions = new Map([
    ["shared", { agent: "reviewer", model: { providerID: "composer", id: "default" } }],
    ["other", { agent: "reviewer", model: { providerID: "composer", id: "default" } }],
  ])
  const install = async (directory: string, runtimeStorage = stored) => {
    const hooks: Array<(input: { sessionID: string }) => Promise<void>> = []
    const commands: Record<string, { execute(input: { sessionID: string }): Promise<void> }> = {}
    const routing = await registerAgentRouting({
      model: { list: async () => ({ data: [{ providerID: "provider-a", id: "primary", enabled: true }] }) },
      storage: {
        get: async (key: string) => runtimeStorage.get(key), set: async (key: string, value: unknown) => { runtimeStorage.set(key, value) },
        remove: async (key: string) => { runtimeStorage.delete(key) }, scan: async () => ({ entries: [] }),
      },
      rpc: () => ({ status: async () => { throw new Error("not configured") } }),
      agent: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
      session: {
        hook: async (name: string, callback: (input: { sessionID: string }) => Promise<void>) => {
          if (name === "prompt") hooks.push(callback)
          return { dispose: async () => {} }
        },
        get: async ({ sessionID }: { sessionID: string }) => ({ data: sessions.get(sessionID) }),
        switchModel: async ({ sessionID, model }: { sessionID: string; model: { providerID: string; id: string } }) => {
          sessions.get(sessionID)!.model = model
        },
      },
      command: {
        transform: async (callback: (editor: { add(command: { name: string; execute(input: { sessionID: string }): Promise<void> }): void }) => void) => {
          callback({ add: (command) => { commands[command.name] = command } })
          return { dispose: async () => {} }
        },
      },
      location: { directory },
    } as never, ownerConfig)
    return { hooks, commands, routing }
  }

  const first = await install("project-a")
  await first.commands["qm-manual"].execute({ sessionID: "shared" })
  await first.hooks[0]({ sessionID: "shared" })
  assert.deepEqual(sessions.get("shared")?.model, { providerID: "composer", id: "default" }, "manual opt-out preserves the host model")
  await first.routing?.dispose()

  const otherProject = await install("project-b")
  await otherProject.hooks[0]({ sessionID: "shared" })
  assert.deepEqual(sessions.get("shared")?.model, { providerID: "provider-a", id: "primary" }, "manual opt-out is isolated to its project")
  await otherProject.routing?.dispose()

  sessions.get("shared")!.model = { providerID: "composer", id: "default" }
  const otherRuntime = await install("project-a", new Map())
  await otherRuntime.hooks[0]({ sessionID: "shared" })
  assert.deepEqual(sessions.get("shared")?.model, { providerID: "provider-a", id: "primary" }, "independent runtime storage does not inherit another runtime's manual opt-out")
  await otherRuntime.routing?.dispose()

  sessions.get("shared")!.model = { providerID: "composer", id: "default" }
  const reloaded = await install("project-a")
  await reloaded.hooks[0]({ sessionID: "other" })
  assert.deepEqual(sessions.get("other")?.model, { providerID: "provider-a", id: "primary" }, "manual opt-out is isolated to its session")
  await reloaded.hooks[0]({ sessionID: "shared" })
  assert.deepEqual(sessions.get("shared")?.model, { providerID: "composer", id: "default" }, "manual opt-out survives plugin reload")
  await reloaded.routing?.dispose()
})

test("named plan query recommends without applying, pinning, reserving, or inferring", async () => {
  const namedConfig = parseConfig({
    plans: {
      review: ["provider-a/primary", { id: "provider-b/backup", variant: "fast" }],
      other: ["provider-b/backup"],
      absent: ["missing/model"],
    },
    agents: { reviewer: "review" },
    workTypes: { deep: "other" },
  })
  const calls: string[] = []
  const { editor, agents } = editorWith({ reviewer: { id: "reviewer", model: { providerID: "host", id: "old" } } })
  let transform: ((editor: AgentEditor) => void) | undefined
  const routing = await registerAgentRouting({
    model: {
      list: async () => {
        calls.push("models")
        return { data: registry.map((model) => ({ providerID: model.providerID, id: model.modelID, enabled: true })) }
      },
    },
    storage: {
      get: async () => undefined,
      set: async () => { calls.push("storage") },
      remove: async () => {},
      scan: async () => ({ entries: [] }),
    },
    rpc: () => ({ status: async () => { throw new Error("not configured") } }),
    agent: {
      transform: async (callback: (editor: AgentEditor) => void) => {
        calls.push("transform")
        transform = callback
        callback(editor as AgentEditor)
        return { dispose: async () => {} }
      },
      reload: async () => { calls.push("reload"); transform?.(editor as AgentEditor) },
    },
  } as never, namedConfig)
  const before = calls.slice()
  const picked = await routing?.selectPlan("review")
  assert.equal(picked?.status, "selected")
  assert.equal(picked?.selected?.modelID, "primary")
  assert.equal(picked?.plan?.id, "review")
  assert.equal(picked?.plan?.source, "named-plan")
  assert.deepEqual(calls, [...before, "models"], "a named-plan query refreshes the enabled model list without reloading agents, storing pins, or switching models")
  assert.deepEqual(agents.reviewer.model, { providerID: "provider-a", id: "primary" })
  const work = await routing?.select("reviewer", "deep") as { plan?: { id?: string; source?: string }; selected?: { modelID?: string } } | undefined
  assert.equal(work?.plan?.id, "other")
  assert.equal(work?.plan?.source, "work-type")
  assert.equal(work?.selected?.modelID, "backup")
  await routing?.pin("reviewer", backup)
  const afterPin = calls.slice()
  const pinnedModel = { ...agents.reviewer.model }
  const unpinned = await routing?.selectPlan("review")
  assert.equal(unpinned?.selected?.modelID, "primary")
  assert.equal(unpinned?.reasonCode, "highest-priority-eligible")
  assert.deepEqual(calls, [...afterPin, "models"], "a later named-plan query refreshes models without storing another pin or reloading agents")
  assert.deepEqual(agents.reviewer.model, pinnedModel)
  const agentPick = await routing?.select("reviewer") as { selected?: { modelID?: string }; reasonCode?: string; plan?: { source?: string } } | undefined
  assert.equal(agentPick?.selected?.modelID, "backup")
  assert.equal(agentPick?.reasonCode, "manual-pin")
  assert.equal(agentPick?.plan?.source, "agent")
  const unknown = await routing?.selectPlan("missing")
  assert.equal(unknown?.status, "no-plan")
  assert.equal(unknown?.reasonCode, "unknown-plan")
  assert.equal(unknown?.skipped.length, 0)
  const exhausted = await routing?.selectPlan("absent")
  assert.equal(exhausted?.status, "no-eligible")
  assert.equal(exhausted?.skipped[0]?.code, "not-in-registry")
  await routing?.dispose()
})

test("a named plan works without an agent binding or session", async () => {
  let transformed = false
  const routing = await registerAgentRouting({
    model: { list: async () => ({ data: [{ providerID: "provider-a", id: "primary", enabled: true }] }) },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    rpc: () => ({ status: async () => { throw new Error("not configured") } }),
    agent: {
      transform: async () => { transformed = true; return { dispose: async () => {} } },
      reload: async () => { throw new Error("named plan must not reload agents") },
    },
  } as never, parseConfig({ plans: { review: ["provider-a/primary"] } }))
  assert.equal(transformed, false)
  const picked = await routing?.selectPlan("review")
  assert.equal(picked?.status, "selected")
  assert.equal(picked?.selected?.providerID, "provider-a")
  assert.equal(picked?.selected?.modelID, "primary")
  assert.equal((await routing?.select("anyone"))?.reasonCode, "unbound-agent")
  await routing?.dispose()
})

test("named plan selection refreshes a stale registry and quota without switching a session", async () => {
  const planConfig = parseConfig({
    plans: { review: ["openai/gpt-6-luna"] },
    usageSources: { openai: "codex" },
  })
  let enabled = false
  let availability: "available" | "limited" = "available"
  const usage = () => {
    const checkedAt = new Date().toISOString()
    const limited = availability === "limited"
    const source = {
      authenticated: true,
      checkedAt,
      stale: false,
      error: null,
      windows: [{
        name: "weekly",
        usedPercent: limited ? 100 : 40,
        state: limited ? "rate-limited" : "ok",
        resetsAt: limited ? new Date(Date.now() + 60_000).toISOString() : null,
        ...(limited ? { resetEstimated: true } : {}),
      }],
      nextAvailableAt: limited ? new Date(Date.now() + 60_000).toISOString() : null,
      availability,
    }
    return { schemaVersion: 1, updatedAt: checkedAt, sources: { go: source, codex: source, cursor: source }, models: { go: {} } }
  }
  let listed = 0
  let usageReads = 0
  let switches = 0
  const routing = await registerAgentRouting({
    model: { list: async () => {
      listed += 1
      return { data: enabled ? [{ providerID: "openai", id: "gpt-6-luna", enabled: true }] : [] }
    } },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    rpc: () => ({ status: async () => { usageReads += 1; return usage() } }),
    agent: {
      transform: async () => ({ dispose: async () => {} }),
      reload: async () => { throw new Error("named plan must not reload agents") },
    },
    session: { switchModel: async () => { switches += 1 } },
  } as never, planConfig)

  const hidden = await routing?.selectPlan("review")
  assert.equal(hidden?.status, "no-eligible")
  assert.equal(hidden?.skipped[0]?.code, "not-in-registry")
  const listedAfterHidden = listed
  const readsAfterHidden = usageReads

  enabled = true
  const selected = await routing?.selectPlan("review")
  assert.equal(selected?.status, "selected")
  assert.equal(selected?.selected?.providerID, "openai")
  assert.equal(selected?.selected?.modelID, "gpt-6-luna")
  assert.equal(selected?.reasonCode, "highest-priority-eligible")
  assert.ok(listed > listedAfterHidden, "enabling the model is visible on the next named-plan query")
  assert.ok(usageReads > readsAfterHidden, "named-plan selection reads cached usage")

  availability = "limited"
  const limited = await routing?.selectPlan("review")
  assert.equal(limited?.status, "no-eligible")
  assert.equal(limited?.skipped[0]?.code, "limited")

  availability = "available"
  await routing?.reportFailure({ providerID: "openai", modelID: "gpt-6-luna", classification: "model-outage" })
  const cooling = await routing?.selectPlan("review")
  assert.equal(cooling?.status, "no-eligible")
  assert.equal(cooling?.skipped[0]?.code, "cooldown")
  assert.equal(switches, 0, "a named-plan query does not switch a session")
  await routing?.dispose()
})
