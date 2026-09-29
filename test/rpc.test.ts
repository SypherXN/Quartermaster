import assert from "node:assert/strict"
import test from "node:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { parseConfig } from "../src/config.ts"
import { QUARTERMASTER_RPC, registerQuartermasterRpc, requestSelection } from "../src/rpc.ts"

const config = parseConfig({ plans: { p: ["provider-a/primary"] }, agents: { reviewer: "p" }, workTypes: { review: "p" }, usageSources: { "provider-a": "codex" } })
const model = { providerID: "provider-a", modelID: "primary", variant: "thinking" }

function context(routing?: unknown) {
  let handlers: Record<string, (input: unknown, call: never) => unknown> | undefined
  let disposed = false
  const rpc = Object.assign((definition: { id: string }) => {
    if (!handlers || definition.id !== QUARTERMASTER_RPC.id) throw new Error("RPC service missing")
    return new Proxy({}, { get: (_target, name: string) => (input: unknown) => handlers?.[name](input, {
      error: (code: string, message: string, data: unknown) => { throw Object.assign(new Error(message), { code, data }) },
    } as never) })
  }, {
    register: async (_definition: unknown, methods: typeof handlers) => {
      handlers = methods
      return { dispose: async () => { disposed = true; handlers = undefined } }
    },
  })
  const ctx = { rpc, model: { list: async () => ({ data: [{ providerID: model.providerID, id: model.modelID, enabled: true }] }) } }
  return {
    ctx,
    disposed: () => disposed,
    register: () => registerQuartermasterRpc(ctx as unknown as Pick<Context, "rpc" | "model">, config, routing as never),
    client: () => ctx.rpc(QUARTERMASTER_RPC) as Record<string, (input: unknown) => Promise<Record<string, unknown>>>,
  }
}

test("separate RPC client receives versioned selection and explanation", async () => {
  const routing = {
    select: async () => ({ status: "selected", selected: model, reasonCode: "highest-priority-eligible", reason: "Primary eligible.", skipped: [] }),
    explain: () => ({ status: "selected", reasonCode: "highest-priority-eligible", reason: "Primary eligible.", skipped: [] }),
    status: () => ({ apiVersion: 1, status: "ok", sources: {} }),
  }
  const testContext = context(routing)
  await testContext.register()
  const result = await requestSelection(testContext.ctx as unknown as Pick<Context, "rpc">, { agent: "reviewer", workType: "review" })
  if (result.status !== "selected") throw new Error("expected selected model")
  assert.equal(result.apiVersion, 1)
  assert.deepEqual(result.selected, model)
  assert.equal(result.reasonCode, "highest-priority-eligible")
  assert.equal((await testContext.client().explain({ agent: "reviewer" })).status, "selected")
})

test("unbound agent and absent service return explicit outcomes", async () => {
  const testContext = context()
  await testContext.register()
  assert.equal((await testContext.client().select({ agent: "missing" })).status, "no-plan")
  const result = await requestSelection({ rpc: () => { throw new Error("missing") } } as never, { agent: "reviewer" })
  assert.equal(result.reasonCode, "service-unavailable")
})

test("safe selection rejects invalid responses and bounds unavailable calls", async () => {
  for (const response of [
    { status: "anything" },
    { status: "selected", apiVersion: 2, reasonCode: "ok", reason: "ok", selected: model, skipped: [] },
    { status: "selected", apiVersion: 1, reasonCode: "ok", reason: "ok", selected: { ...model, variant: 42 }, skipped: [] },
  ]) {
    const invalid = await requestSelection({ rpc: () => ({ select: async () => response }) } as never, { agent: "reviewer" })
    assert.equal(invalid.reasonCode, "invalid-response")
  }

  let signal: AbortSignal | undefined
  const timedOut = await requestSelection({
    rpc: () => ({ select: async (_input: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal
      return new Promise(() => {})
    } }),
  } as never, { agent: "reviewer" }, 5)
  assert.equal(timedOut.reasonCode, "timeout")
  assert.equal(signal?.aborted, true)
})

test("non-selected outcomes pass through after one request without retry", async () => {
  let requests = 0
  const response = {
    apiVersion: 1,
    status: "no-eligible",
    reasonCode: "no-eligible-model",
    reason: "No registered candidate is eligible.",
    skipped: [{ providerID: "provider-a", modelID: "primary" }],
  }
  const result = await requestSelection({
    rpc: () => ({ select: async () => { requests += 1; return response } }),
  } as never, { agent: "reviewer", workType: "review" })
  assert.deepEqual(result, response)
  assert.equal(requests, 1)
})

test("pin and failure methods validate against the enabled registry", async () => {
  const routing = {
    select: async (_agent: string, workType?: string) => workType === "none"
      ? { status: "no-eligible", reasonCode: "no-eligible", reason: "No candidate.", skipped: [{ model, code: "stale", reason: "Stale." }] }
      : { status: "no-plan", reasonCode: "unknown-work-type", reason: "Unknown type.", skipped: [] },
    explain: () => ({ status: "no-plan", reasonCode: "unbound-agent", reason: "No plan.", skipped: [] }),
    status: () => ({ apiVersion: 1, status: "ok", sources: {} }),
    refresh: async () => false,
    pin: async (_agent: string, value: unknown) => value,
    unpin: async () => true,
    reportFailure: async () => true,
    reportSuccess: async () => true,
  }
  const testContext = context(routing)
  await testContext.register()
  const client = testContext.client()
  assert.equal((await client.select({ agent: "reviewer", workType: "none" })).reasonCode, "no-eligible")
  assert.deepEqual((await client.pin({ agent: "reviewer", model })).model, model)
  assert.equal((await client.unpin({ agent: "reviewer" })).status, "unpinned")
  assert.equal((await client.reportFailure({ providerID: "provider-a", classification: "provider-outage" })).accepted, true)
  assert.equal((await client.reportSuccess({ providerID: "provider-a", scope: "provider" })).accepted, true)
  await assert.rejects(client.select({ agent: " " }), (error: Error & { code?: string }) => error.code === "invalid_input")
  await assert.rejects(client.reportFailure({ providerID: "provider-a", classification: "model-outage" }), (error: Error & { code?: string }) => error.code === "invalid_input")
})

test("status omits upstream error text and RPC registration is disposable", async () => {
  const source = { authenticated: false, checkedAt: Date.now(), stale: true, error: "secret token", windows: [], nextAvailableAt: null, availability: "unknown" }
  const usage = { status: "ok", snapshot: { updatedAt: Date.now(), sources: { codex: source } } }
  const testContext = context()
  const registration = await registerQuartermasterRpc(testContext.ctx as never, config, undefined, usage as never)
  const status = await testContext.client().status({})
  assert.equal(JSON.stringify(status).includes("secret token"), false)
  assert.equal(JSON.stringify(status).includes('"stale":true'), true)
  await registration.dispose()
  assert.equal(testContext.disposed(), true)
})
