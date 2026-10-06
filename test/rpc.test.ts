import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { parseConfig } from "../src/config.ts"
import { QUARTERMASTER_RPC, registerQuartermasterRpc, requestReport, requestSelection } from "../src/rpc.ts"

const config = parseConfig({ plans: { p: ["provider-a/primary"] }, agents: { reviewer: "p" }, workTypes: { review: "p" }, usageSources: { "provider-a": "codex" } })
const model = { providerID: "provider-a", modelID: "primary", variant: "thinking" }

function context(routing?: unknown, reporting?: unknown, optionsDirectory?: string) {
  let handlers: Record<string, (input: unknown, call: never) => unknown> | undefined
  let disposed = false
  const rpc = Object.assign((definition: { id: string }) => {
    if (!handlers || definition.id !== QUARTERMASTER_RPC.id) throw new Error("RPC service missing")
    return new Proxy({}, { get: (_target, name: string) => (input: unknown, options?: { signal?: AbortSignal }) => handlers?.[name](input, {
      signal: options?.signal ?? new AbortController().signal,
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
    register: () => registerQuartermasterRpc(ctx as unknown as Pick<Context, "rpc" | "model">, config, routing as never, undefined, reporting as never, optionsDirectory),
    client: () => ctx.rpc(QUARTERMASTER_RPC) as Record<string, (input: unknown, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>>,
  }
}

test("plugin integration docs describe the project-options RPC contract", async () => {
  const docs = await readFile(new URL("../docs/PLUGIN_INTEGRATION.md", import.meta.url), "utf8")
  const section = docs.split("## Configuration editing capability\n")[1]?.split("\n## ")[0]
  assert.ok(section)
  assert.match(section, /`readOptions\(\{\}\)`/)
  assert.match(section, /`applyOptions\(\{ options, revision \}\)`/)
  assert.match(section, /`apiVersion: 1`/)
  assert.match(section, /`status: "ok"`/)
  assert.match(section, /`status: "saved"`/)
  assert.match(section, /`stale-revision`/)
  assert.match(section, /`quartermaster-options`/)
  assert.match(section, /`quartermaster` grant remains read-only/)
  assert.doesNotMatch(docs, /has no project-configuration write RPC|not an RPC, writes/)
  const readme = await readFile(new URL("../web/README.md", import.meta.url), "utf8")
  assert.match(readme, /`quartermaster-options`/)
  assert.doesNotMatch(readme, /no live project-config writer|no general proxy or write route|bridge is likewise not implemented|still needs the OpenChamber bridge/i)
})

test("project-options RPC uses its bound directory and never returns a path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qm-rpc-options-"))
  const otherDirectory = await mkdtemp(join(tmpdir(), "qm-rpc-options-other-"))
  const text = JSON.stringify({ plugins: [{ package: "quartermaster", options: { plans: { review: ["provider-a/old"] } } }] })
  try {
    const path = join(directory, "opencode.json")
    const otherPath = join(otherDirectory, "opencode.json")
    await writeFile(path, text)
    await writeFile(otherPath, text)
    const originalOther = await readFile(otherPath, "utf8")
    const testContext = context(undefined, undefined, directory)
    await testContext.register()
    const client = testContext.client()
    const current = await client.readOptions({})
    assert.deepEqual(current, { apiVersion: 1, status: "ok", options: JSON.parse(text).plugins[0].options, revision: (await stat(path)).mtimeMs })
    assert.equal("path" in current, false)
    assert.equal("directory" in current, false)

    const nextOptions = { plans: { review: ["provider-a/new"] } }
    const saved = await client.applyOptions({ options: nextOptions, revision: current.revision })
    assert.deepEqual(saved, { apiVersion: 1, status: "saved", options: nextOptions, revision: (await stat(path)).mtimeMs })
    assert.deepEqual(JSON.parse((await readFile(path, "utf8")).replace(/\/\/[^\n]*/g, "" )).plugins[0].options, nextOptions)
    assert.equal(await readFile(otherPath, "utf8"), originalOther)
    assert.equal("path" in current, false)

    const stale = await client.readOptions({})
    await writeFile(path, text + "\n")
    await assert.rejects(client.applyOptions({ options: nextOptions, revision: stale.revision }), (error: Error & { code?: string }) => error.code === "unavailable")
    await assert.rejects(client.applyOptions({ options: nextOptions, revision: 0, extra: true }), (error: Error & { code?: string }) => error.code === "invalid_input")

    const beforeCancelledWrite = await readFile(path, "utf8")
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(client.applyOptions({ options: nextOptions, revision: (await stat(path)).mtimeMs }, { signal: controller.signal }))
    assert.equal(await readFile(path, "utf8"), beforeCancelledWrite)
  } finally {
    await rm(directory, { recursive: true, force: true })
    await rm(otherDirectory, { recursive: true, force: true })
  }
})

test("report RPC rejects unbounded and cross-project requests without leaking data", async () => {
  const reporting = {
    projectID: "project-a",
    tokenLedger: { list: async () => [] },
    errorLedger: { list: async () => [] },
    attributionLedger: { list: async () => [] },
    budgets: [],
    tokenRates: undefined,
    now: () => 123,
  }
  const testContext = context(undefined, reporting)
  await testContext.register()
  const client = testContext.client()
  const report = await client.report({ refresh: true })
  assert.equal(report.status, "ok")
  assert.equal(report.apiVersion, 1)
  assert.equal(report.projectID, "project-a")
  assert.equal(report.generatedAt, 123)
  assert.equal(report.refresh, "reread")
  const denied = await client.report({ projectID: "project-b" })
  assert.equal(denied.status, "unsupported")
  assert.equal(denied.reasonCode, "cross-project-authorization-unavailable")
  assert.equal(denied.projectID, undefined)
  await assert.rejects(client.report({ limit: 101 }), (error: Error & { code?: string }) => error.code === "invalid_input")
  await assert.rejects(client.report({ since: 200, until: 100 }), (error: Error & { code?: string }) => error.code === "invalid_input")
})

test("report helper returns explicit missing-service outcome", async () => {
  const result = await requestReport({ rpc: () => { throw new Error("missing") } } as never)
  assert.equal(result.status, "unavailable")
  assert.equal(result.reasonCode, "service-unavailable")

  const timedOut = await requestReport({
    rpc: () => ({ report: async () => new Promise(() => {}) }),
  } as never, {}, 5)
  assert.equal(timedOut.status, "unavailable")
  assert.equal(timedOut.reasonCode, "timeout")
})

test("plugin usage claims are opt-in, bounded, and scoped to the active project", async () => {
  const claims: unknown[][] = []
  const testContext = context(undefined, {
    projectID: "project-a",
    tokenLedger: { list: async () => [] },
    errorLedger: { list: async () => [] },
    attributionLedger: { claim: async (...args: unknown[]) => { claims.push(args) }, list: async () => [] },
    budgets: [],
    tokenRates: undefined,
  })
  await testContext.register()
  const client = testContext.client()
  const accepted = await client.reportPluginUsage({ pluginID: "plugin-a", pluginName: "Plugin A", sessionIDs: ["session-1", "session-1", "child-1"] })
  assert.deepEqual(accepted, {
    apiVersion: 1, status: "accepted", attribution: "self-reported-unverified", acceptedSessions: 2,
  })
  assert.deepEqual(claims, [["project-a", "plugin-a", "Plugin A", ["session-1", "child-1"]]])
  await assert.rejects(client.reportPluginUsage({ pluginName: "name only", sessionIDs: ["session-1"] }), (error: Error & { code?: string }) => error.code === "invalid_input")
  await assert.rejects(client.reportPluginUsage({ pluginID: "plugin-a", pluginName: "Plugin A", sessionIDs: [] }), (error: Error & { code?: string }) => error.code === "invalid_input")
  await assert.rejects(client.reportPluginUsage({ pluginID: "plugin-a", pluginName: "Plugin A", projectID: "project-b", sessionIDs: ["session-1"] }), (error: Error & { code?: string }) => error.code === "invalid_input")
  await assert.rejects(client.reportPluginUsage({ pluginID: "plugin-a", pluginName: "Plugin A", sessionIDs: Array.from({ length: 101 }, (_, index) => `session-${index}`) }), (error: Error & { code?: string }) => error.code === "invalid_input")
})

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
