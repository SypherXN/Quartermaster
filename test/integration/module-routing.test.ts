import assert from "node:assert/strict"
import test from "node:test"
import { parseConfig, type QuartermasterConfig } from "../../src/config.ts"
import { ModuleCooldowns } from "../../src/modules.ts"
import { registerQuartermasterRpc, requestModuleSelection, reportModuleCooldown, requestSelection } from "../../src/rpc.ts"
import { ProjectConfigurationUnresolved } from "../../src/project-options.ts"

const config = parseConfig({ modules: {
  consumer: { models: ["external/free", "external/paid"], cooldownMs: 100 },
  other: { models: ["external/free"], cooldownMs: 100 },
} })
type Methods = Record<string, (input: unknown, call: never) => Promise<unknown>>
function harness() {
  let now = 10
  let fail = false
  const values = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => structuredClone(values.get(key)),
    set: async (key: string, value: unknown) => {
      if (fail) throw new Error("synthetic storage failure")
      values.set(key, structuredClone(value))
    },
  }
  async function connect(project = "project", options: { refresh?: () => Promise<unknown>; config?: QuartermasterConfig } = {}) {
    const state = await ModuleCooldowns.load(options.config ?? config, storage, project, () => now, options.refresh)
    let methods: Methods | undefined
    let selections = 0
    const rpc = Object.assign(() => {
      if (!methods) throw new Error("service missing")
      return new Proxy({}, { get: (_, name: string) => (input: unknown, options: { signal: AbortSignal }) => {
        if (name === "selectModule") selections++
        return methods![name](input, { signal: options.signal,
          error: (code: string, _message: string, data?: { reason?: string }) => { throw new Error(`${code}: ${data?.reason ?? ""}`) },
        } as never)
      } })
    }, { register: async (_: unknown, handlers: Methods) => {
      methods = handlers
      return { dispose: async () => { methods = undefined } }
    } })
    const ctx = { rpc, model: { list: async () => { throw new Error("native catalog must not be accessed") } } }
    const registration = await registerQuartermasterRpc(ctx as never, config, undefined, undefined, undefined, undefined, undefined, state)
    return { ctx: ctx as never, state, registration, methods: () => methods!, selections: () => selections }
  }
  return { connect, clock: () => now, advance: (value: number) => { now = value }, fail: () => { fail = true } }
}

// Fake consumer only: OPR policy and real serving behavior belong to separate checks.
async function consume(ctx: Parameters<typeof requestModuleSelection>[0], clock: () => number,
  transport: (model: string, deadline: number, signal: AbortSignal) => Promise<{ status: number }>,
  signal = new AbortController().signal,
) {
  const deadline = clock() + 50
  const seen = new Set<string>()
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted || clock() >= deadline) return
    const selected = await requestModuleSelection(ctx, { module: "consumer" }, Math.min(2000, deadline - clock()), signal)
    if (selected.status !== "selected") return
    if (signal.aborted || clock() >= deadline) return
    const { providerID, modelID } = selected.selected
    const key = JSON.stringify([providerID, modelID])
    if (providerID !== "external" || !["free", "paid"].includes(modelID) || seen.has(key)) return
    seen.add(key)
    const result = await transport(modelID, deadline, signal)
    if (result.status !== 429) return result
    if (signal.aborted || clock() >= deadline) return
    const ack = await reportModuleCooldown(ctx, { module: "consumer", providerID, modelID, reason: "rate-limit" }, Math.min(2000, deadline - clock()), signal)
    if (!ack.accepted) return
  }
}

test("public module feedback reroutes actual fake calls and restores free priority", async () => {
  const h = harness()
  const a = await h.connect()
  const calls: string[] = []
  const signal = new AbortController().signal
  const result = await consume(a.ctx, h.clock, async (model, deadline, received) => {
    calls.push(model)
    assert.equal(deadline, 60)
    assert.equal(received, signal)
    h.advance(20)
    return { status: model === "free" ? 429 : 200 }
  }, signal)
  assert.equal(result?.status, 200)
  assert.deepEqual(calls, ["free", "paid"])
  const restarted = await h.connect()
  assert.equal((await requestModuleSelection(restarted.ctx, { module: "consumer" })).status, "selected")
  assert.equal(restarted.state.select("consumer").candidates[0].reason, "cooldown")
  h.advance(120)
  calls.length = 0
  await consume(restarted.ctx, h.clock, async model => { calls.push(model); return { status: 200 } })
  assert.deepEqual(calls, ["free"])
  await a.registration.dispose()
  await restarted.registration.dispose()
})

test("consumer bounds exhaustion, failed reports, cancellation and the original deadline", async () => {
  for (const scenario of ["exhausted", "failed", "cancelled", "deadline", "missing"] as const) {
    const h = harness()
    const a = await h.connect()
    const controller = new AbortController()
    const calls: string[] = []
    if (scenario === "missing") await a.registration.dispose()
    if (scenario === "cancelled") controller.abort()
    if (scenario === "failed") h.fail()
    await consume(a.ctx, h.clock, async model => {
      calls.push(model)
      if (scenario === "deadline") h.advance(60)
      return { status: 429 }
    }, controller.signal)
    assert.deepEqual(calls, scenario === "exhausted" ? ["free", "paid"] :
      ["cancelled", "missing"].includes(scenario) ? [] : ["free"], scenario)
    if (scenario === "exhausted") assert.equal((await requestModuleSelection(a.ctx, { module: "consumer" })).status, "no-eligible")
    if (scenario === "failed") {
      assert.equal(a.selections(), 1)
      assert.equal(a.state.select("consumer").candidates[0].reason, "cooldown")
    }
    await a.registration.dispose()
  }
})

test("consumer rejects a repeated recommendation instead of spinning", async () => {
  const h = harness()
  const a = await h.connect()
  const original = a.methods().selectModule
  const initial = await requestModuleSelection(a.ctx, { module: "consumer" })
  a.methods().selectModule = async () => initial
  const calls: string[] = []
  await consume(a.ctx, h.clock, async model => { calls.push(model); return { status: 429 } })
  assert.deepEqual(calls, ["free"])
  assert.equal(a.selections(), 3)
  a.methods().selectModule = original
  await a.registration.dispose()
})

test("public feedback stays module/project scoped and leaves native selection untouched", async () => {
  const h = harness()
  const a = await h.connect()
  const b = await h.connect("other-project")
  const nativeBefore = await requestSelection(a.ctx, { agent: "reviewer" })
  const input = { module: "consumer", providerID: "external", modelID: "free", reason: "rate-limit" as const }
  assert.equal((await reportModuleCooldown(a.ctx, { ...input, modelID: "unknown" })).accepted, false)
  assert.equal((await reportModuleCooldown(a.ctx, input)).accepted, true)
  for (const [ctx, module] of [[a.ctx, "other"], [b.ctx, "consumer"]] as const) {
    const selected = await requestModuleSelection(ctx, { module })
    assert.equal(selected.status, "selected")
    if (selected.status === "selected") assert.equal(selected.selected.modelID, "free")
  }
  assert.deepEqual(await requestSelection(a.ctx, { agent: "reviewer" }), nativeBefore)
  assert.equal(nativeBefore.status, "no-plan")
  assert.equal(a.state.snapshot("other").length, 0)
  await a.registration.dispose()
  await b.registration.dispose()
})

test("a failed configuration read keeps the last known good selection", async () => {
  const h = harness()
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (message: unknown) => { warnings.push(String(message)) }
  try {
    const a = await h.connect("project", { refresh: async () => { throw new ProjectConfigurationUnresolved("Receiving server configuration provenance is unavailable") } })
    const selection = await requestModuleSelection(a.ctx, { module: "consumer" })
    if (selection.status !== "selected") throw new Error("expected the declared candidate")
    assert.deepEqual(selection.selected, { providerID: "external", modelID: "free" })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.ok(warnings.some(warning => warning.includes("module configuration refresh failed")), "the failed read is reported")
    await a.registration.dispose()
  } finally {
    console.warn = warn
  }
})

test("a module query does not wait for a stalled configuration read", async () => {
  const h = harness()
  const a = await h.connect("project", { refresh: () => new Promise<never>(() => {}) })
  let timer: ReturnType<typeof setTimeout> | undefined
  const started = Date.now()
  const selection = await Promise.race([
    requestModuleSelection(a.ctx, { module: "consumer" }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the module query waited for the configuration read")), 1_000)
    }),
  ]).finally(() => clearTimeout(timer))
  if (selection.status !== "selected") throw new Error("expected the declared candidate")
  assert.deepEqual(selection.selected, { providerID: "external", modelID: "free" })
  assert.ok(Date.now() - started < 1_000, "the query answers inside the read budget")
  await a.registration.dispose()
})

test("a stored cooldown row keeps a consistent remaining deadline", async () => {
  const h = harness()
  const a = await h.connect()
  const ack = await reportModuleCooldown(a.ctx, { module: "consumer", providerID: "external", modelID: "free", reason: "rate-limit" })
  assert.equal(ack.accepted, true)
  const selection = await requestModuleSelection(a.ctx, { module: "consumer" })
  if (selection.status !== "selected") throw new Error("expected the paid candidate")
  assert.deepEqual(selection.selected, { providerID: "external", modelID: "paid" })
  const candidate = selection.candidates.find(entry => entry.modelID === "free")
  if (candidate?.reason !== "cooldown") throw new Error("expected a cooldown candidate")
  assert.ok(candidate.blockedUntil! > selection.evaluatedAt)
  assert.equal(candidate.remainingMs, candidate.blockedUntil! - selection.evaluatedAt)
  await a.registration.dispose()
})

test("an unreadable configuration reports a coded reason instead of a guess", async () => {
  const h = harness()
  const a = await h.connect("project", { config: parseConfig({}) })
  a.state.noteConfigurationFailure(new Error("Receiving server configuration provenance is unavailable"))
  const call = { signal: new AbortController().signal,
    error: (code: string, _message: string, data?: { reason?: string }) => { throw new Error(`${code}: ${data?.reason ?? ""}`) } }
  await assert.rejects(a.methods().selectModule({ module: "consumer" }, call as never), /provenance-unavailable/)
  await a.registration.dispose()
})
