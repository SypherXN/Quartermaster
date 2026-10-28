import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { parseConfig } from "../src/config.ts"
import { QUARTERMASTER_RPC, registerQuartermasterRpc, requestReport, requestSelection, requestPlanSelection, requestModuleSelection, reportModuleCooldown } from "../src/rpc.ts"
import { ModuleCooldowns } from "../src/modules.ts"
import { fixtureConfiguration } from "./configuration-fixture.ts"

const config = parseConfig({ plans: { p: ["provider-a/primary"] }, agents: { reviewer: "p" }, workTypes: { review: "p" }, usageSources: { "provider-a": "codex" } })
const model = { providerID: "provider-a", modelID: "primary", variant: "thinking" }

function context(routing?: unknown, reporting?: unknown, optionsDirectory?: string, modules?: ModuleCooldowns) {
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
    register: () => registerQuartermasterRpc(ctx as unknown as Pick<Context, "rpc" | "model">, config, routing as never, undefined, reporting as never, optionsDirectory, fixtureConfiguration, modules),
    client: () => ctx.rpc(QUARTERMASTER_RPC) as Record<string, (input: unknown, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>>,
  }
}

test("module RPC validates exact scope without a native registry and preserves version one", async () => {
  const modules = await ModuleCooldowns.load(parseConfig({ modules: { direct: { models: ["external/decision"], cooldownMs: 100 } } }),
    { get: async () => undefined, set: async () => {} }, "fixture", () => 10)
  const fixture = context(undefined, undefined, undefined, modules)
  fixture.ctx.model.list = async () => { throw new Error("must not list native models") }
  await fixture.register()
  const ctx = fixture.ctx as never
  const selected = await requestModuleSelection(ctx, { module: "direct" })
  assert.equal(selected.status, "selected")
  if (selected.status === "selected") assert.deepEqual(selected.selected, { providerID: "external", modelID: "decision" })
  const input = { module: "direct", providerID: "external", modelID: "decision", reason: "rate-limit" as const }
  assert.deepEqual(await reportModuleCooldown(ctx, input), { apiVersion: 1, accepted: true, module: "direct", providerID: "external", modelID: "decision", blockedUntil: 110 })
  assert.equal((await requestModuleSelection(ctx, { module: "direct" })).status, "no-eligible")
  assert.equal((await requestModuleSelection(ctx, { module: "absent" })).status, "no-module")
  assert.deepEqual(await reportModuleCooldown(ctx, { ...input, modelID: "absent" }), { apiVersion: 1, accepted: false, reason: "unknown-model" })
  assert.deepEqual(await reportModuleCooldown(ctx, { ...input, module: "absent" }), { apiVersion: 1, accepted: false, reason: "unknown-module" })
  for (const invalid of [null, {}, { ...input, modelID: undefined }, { ...input, durationMs: 100 }, { ...input, error: "raw" }, { ...input, reason: "auth" }]) {
    await assert.rejects(fixture.client().reportModuleCooldown(invalid), { code: "invalid_input" })
  }
  for (const invalid of [{ module: " " }, { module: "direct", agent: "reviewer" }]) {
    await assert.rejects(fixture.client().selectModule(invalid), { code: "invalid_input" })
  }
})

test("module helpers reject malformed selection metadata and mismatched acknowledgements", async () => {
  const candidate = { providerID: "external", modelID: "decision", reason: "declared", quota: "unknown", health: "unknown" }
  const good = { apiVersion: 1, module: "direct", status: "selected", evaluatedAt: 10, candidates: [candidate], selected: { providerID: "external", modelID: "decision" } }
  const fake = (value: unknown) => ({ rpc: () => ({ selectModule: async () => value, reportModuleCooldown: async () => value }) }) as never
  const tracked = { ...candidate, providerID: "opencode-go", quota: "available" }
  const limited = { providerID: "cursor", modelID: "composer", reason: "limited", quota: "limited", health: "unknown" }
  const accepted = { ...good, candidates: [limited, tracked], selected: { providerID: "opencode-go", modelID: "decision" } }
  assert.equal((await requestModuleSelection(fake(accepted), { module: "direct" })).status, "selected")
  const skipped = { apiVersion: 1, module: "direct", status: "no-eligible", evaluatedAt: 10, candidates: [limited, { ...candidate, reason: "usage-unavailable" }] }
  assert.equal((await requestModuleSelection(fake(skipped), { module: "direct" })).status, "no-eligible")
  const cooling = { apiVersion: 1, module: "direct", status: "no-eligible", evaluatedAt: 10, nextEligibleAt: 20, candidates: [{ ...candidate, reason: "cooldown", quota: "available", blockedUntil: 20, remainingMs: 10 }] }
  assert.equal((await requestModuleSelection(fake(cooling), { module: "direct" })).status, "no-eligible")
  for (const value of [null, { ...good, apiVersion: 2 }, { ...good, module: "wrong" }, { ...good, evaluatedAt: NaN },
    { ...good, selected: { ...good.selected, variant: 2 } }, { ...good, candidates: [candidate, candidate] },
    { ...good, candidates: [{ ...candidate, reason: "cooldown", blockedUntil: 9, remainingMs: -1 }] },
    { ...good, status: "no-module" }, { ...good, status: "no-eligible" },
    { ...good, candidates: [{ ...candidate, quota: "plenty" }] },
    { ...accepted, selected: { providerID: "cursor", modelID: "composer" } }]) {
    assert.equal((await requestModuleSelection(fake(value), { module: "direct" })).status, "unavailable")
  }
  const input = { module: "direct", providerID: "external", modelID: "decision", reason: "rate-limit" as const }
  const ack = { apiVersion: 1, accepted: true, module: "direct", providerID: "external", modelID: "decision", blockedUntil: 110 }
  for (const value of [null, { ...ack, module: "wrong" }, { ...ack, modelID: "wrong" }, { ...ack, blockedUntil: Infinity },
    { ...ack, apiVersion: 2 }, { apiVersion: 1, accepted: false, reason: "arbitrary" }]) {
    const result = await reportModuleCooldown(fake(value), input)
    assert.equal(result.accepted, false)
    assert.equal("status" in result && result.status, "unavailable")
  }
})

test("module helpers bound hanging calls and propagate caller cancellation", async () => {
  let received: AbortSignal | undefined
  let calls = 0
  const hanging = { rpc: () => ({ selectModule: (_: unknown, options: { signal: AbortSignal }) => {
    calls++; received = options.signal; return new Promise(() => {})
  } }) } as never
  const controller = new AbortController()
  const pending = requestModuleSelection(hanging, { module: "direct" }, 2000, controller.signal)
  controller.abort()
  assert.deepEqual(await pending, { status: "unavailable", reasonCode: "cancelled" })
  assert.equal(received?.aborted, true)
  await requestModuleSelection(hanging, { module: "direct" }, 2000, controller.signal)
  assert.equal(calls, 1)
  assert.deepEqual(await requestModuleSelection(hanging, { module: "direct" }, 5), { status: "unavailable", reasonCode: "timeout" })
  assert.equal(received?.aborted, true)
  assert.equal((await requestModuleSelection(context().ctx as never, { module: "direct" })).status, "unavailable")
  const input = { module: "direct", providerID: "external", modelID: "decision", reason: "rate-limit" as const }
  const reportContext = { rpc: () => ({ reportModuleCooldown: (_: unknown, options: { signal: AbortSignal }) => {
    received = options.signal; return new Promise(() => {})
  } }) } as never
  assert.deepEqual(await reportModuleCooldown(reportContext, input, 5), { status: "unavailable", accepted: false, reasonCode: "timeout" })
  assert.equal(received?.aborted, true)
  assert.equal((await reportModuleCooldown(context().ctx as never, input)).accepted, false)
  assert.equal((await reportModuleCooldown(reportContext, input, 2000, controller.signal)).accepted, false)
})

test("session diagnostics RPC validates input and returns the snapshot without selecting or queueing", async () => {
  const requested: string[] = []
  const routing = { diagnoseSession: async (sessionID: string) => { requested.push(sessionID); return { apiVersion: 1, session: { id: sessionID } } } }
  const fixture = context(routing)
  await fixture.register()
  const client = fixture.client()
  assert.deepEqual(await client.diagnoseSession({ sessionID: "session-a" }), { apiVersion: 1, session: { id: "session-a" } })
  for (const input of [{}, { sessionID: " " }, { sessionID: "a".repeat(257) }, { sessionID: "session-a", projectID: "other" }]) {
    await assert.rejects(client.diagnoseSession(input), (error: Error & { code?: string }) => error.code === "invalid_input")
  }
  assert.deepEqual(requested, ["session-a"])
  const missing = context()
  await missing.register()
  await assert.rejects(missing.client().diagnoseSession({ sessionID: "session-a" }), (error: Error & { code?: string }) => error.code === "unavailable")
})

test("public docs describe module delivery without claiming live provider serving", async () => {
  const guide = (await readFile(new URL("../docs/PLUGIN_INTEGRATION.md", import.meta.url), "utf8")).replaceAll("\r\n", "\n")
  const readme = (await readFile(new URL("../README.md", import.meta.url), "utf8")).replaceAll("\r\n", "\n")
  const deployment = (await readFile(new URL("../docs/DEPLOYMENT.md", import.meta.url), "utf8")).replaceAll("\r\n", "\n")
  const moduleGuide = guide.split("## Direct-call module profiles\n")[1]?.split("\n## ")[0] ?? ""
  for (const phrase of [
    "selectModule", "reportModuleCooldown", "requestModuleSelection", "out of rotation", "Retry-After",
    "moduleRouting.enabled", "allowPaid", "permission-reviewer.jsonc", "fail closed", "OpenCode V1",
    "does not fall back",
  ]) assert.match(moduleGuide, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  for (const phrase of ["usageSources", "quotaExemptModels", "usage-unavailable", "cooldown-only"]) {
    assert.match(moduleGuide, new RegExp(phrase))
  }
  const recommendations = guide.split("## Plugin recommendations\n")[1]?.split("\n## ")[0] ?? ""
  for (const phrase of ["selectPlan", "requestPlanSelection", "requestSelection", "The caller applies"]) {
    assert.match(recommendations, new RegExp(phrase.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")))
  }
  assert.match(readme, /requestPlanSelection/)
  assert.match(readme, /quotaExemptModels/)
  assert.match(readme, /docs\/PLUGIN_INTEGRATION\.md#direct-call-module-profiles/)
  assert.match(readme, /docs\/PLUGIN_INTEGRATION\.md#permission-reviewer-example/)
  assert.doesNotMatch(readme.split("### Direct-call module profiles")[1]?.split("\n### ")[0] ?? "", /"agents"/)
  assert.match(deployment, /permission-reviewer\.jsonc/)
  assert.match(deployment, /does not build, install, or activate/)
  assert.match(deployment, /Retry-After/)
  assert.match(deployment, /2026-10-13 archive/)
  assert.doesNotMatch(`${guide}\n${deployment}`, /live Jev provider (is|was) verified|real Jev rate limit passed/i)
})

test("plugin integration docs describe the project-options RPC contract", async () => {
  const docs = (await readFile(new URL("../docs/PLUGIN_INTEGRATION.md", import.meta.url), "utf8")).replaceAll("\r\n", "\n")
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
  const readme = (await readFile(new URL("../web/README.md", import.meta.url), "utf8")).replaceAll("\r\n", "\n")
  assert.match(readme, /`quartermaster-options`/)
  assert.doesNotMatch(readme, /no live project-config writer|no general proxy or write route|bridge is likewise not implemented|still needs the OpenChamber bridge/i)
})

test("project-options RPC uses its bound directory and never returns a path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qm-rpc-options-"))
  const otherDirectory = await mkdtemp(join(tmpdir(), "qm-rpc-options-other-"))
  const registration = JSON.stringify({ plugins: [{ package: "quartermaster" }] })
  const settings = { plans: { review: ["provider-a/old"] } }
  const settingsText = JSON.stringify(settings, null, 2) + "\n"
  try {
    const path = join(directory, "opencode.json")
    const settingsPath = join(directory, "quartermaster.jsonc")
    const otherPath = join(otherDirectory, "opencode.json")
    const otherSettingsPath = join(otherDirectory, "quartermaster.jsonc")
    await writeFile(path, registration)
    await writeFile(settingsPath, settingsText)
    await writeFile(otherPath, registration)
    await writeFile(otherSettingsPath, settingsText)
    const originalOther = await readFile(otherPath, "utf8")
    const originalOtherSettings = await readFile(otherSettingsPath, "utf8")
    const testContext = context(undefined, undefined, directory)
    await testContext.register()
    const client = testContext.client()
    const current = await client.readOptions({})
    assert.deepEqual(current.options, settings)
    assert.equal(current.status, "ok")
    assert.equal(Number.isSafeInteger(current.revision), true)
    assert.equal("path" in current, false)
    assert.equal("directory" in current, false)

    const nextOptions = { plans: { review: ["provider-a/new"] } }
    const saved = await client.applyOptions({ options: nextOptions, revision: current.revision })
    assert.deepEqual(saved.options, nextOptions)
    assert.equal(saved.status, "saved")
    assert.notEqual(saved.revision, current.revision)
    assert.equal(await readFile(path, "utf8"), registration)
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), nextOptions)
    assert.equal(await readFile(otherPath, "utf8"), originalOther)
    assert.equal(await readFile(otherSettingsPath, "utf8"), originalOtherSettings)
    assert.equal("path" in current, false)

    const stale = await client.readOptions({})
    await writeFile(settingsPath, settingsText + "\n")
    await assert.rejects(client.applyOptions({ options: nextOptions, revision: stale.revision }), (error: Error & { code?: string }) => error.code === "unavailable")
    await assert.rejects(client.applyOptions({ options: nextOptions, revision: 0, extra: true }), (error: Error & { code?: string }) => error.code === "invalid_input")

    const beforeCancelledWrite = await readFile(settingsPath, "utf8")
    const beforeRegistration = await readFile(path, "utf8")
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(client.applyOptions({ options: nextOptions, revision: (await stat(settingsPath)).mtimeMs }, { signal: controller.signal }))
    assert.equal(await readFile(settingsPath, "utf8"), beforeCancelledWrite)
    assert.equal(await readFile(path, "utf8"), beforeRegistration)
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

test("direct usage accepts a plugin's own counts and rejects extra fields", async () => {
  const recorded: unknown[] = []
  const testContext = context(undefined, {
    projectID: "project-a",
    tokenLedger: { list: async () => [] },
    errorLedger: { list: async () => [] },
    attributionLedger: { claim: async () => {}, list: async () => [] },
    directUsageLedger: { record: async (input: unknown) => { recorded.push(input); return { replaced: false } }, list: async () => [] },
    budgets: [],
    tokenRates: undefined,
  })
  await testContext.register()
  const client = testContext.client()
  const accepted = await client.reportDirectUsage({
    pluginID: "opr", pluginName: "OPR", usageID: "jev-1", providerID: "jev", modelID: "review",
    counts: { input: 12, output: 3, cacheRead: 4 },
  })
  assert.equal(accepted.status, "accepted")
  assert.equal(accepted.attribution, "self-reported-unverified")
  assert.deepEqual(recorded, [{
    projectID: "project-a", pluginID: "opr", pluginName: "OPR", usageID: "jev-1",
    providerID: "jev", modelID: "review", variant: null,
    counts: { input: 12, output: 3, reasoning: undefined, cacheRead: 4, cacheWrite: undefined },
  }])
  await assert.rejects(client.reportDirectUsage({ pluginID: "opr", pluginName: "OPR", usageID: "jev-1", providerID: "jev", modelID: "review", counts: { output: 1 } }), (error: Error & { code?: string }) => error.code === "invalid_input")
  await assert.rejects(client.reportDirectUsage({ pluginID: "opr", pluginName: "OPR", usageID: "jev-1", providerID: "jev", modelID: "review", projectID: "other", counts: { input: 1, output: 1 } }), (error: Error & { code?: string }) => error.code === "invalid_input")
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

test("plan selection returns a recommendation the caller applies itself", async () => {
  const calls: string[] = []
  const skip = { model, code: "limited", reason: "provider-a/primary skipped: provider quota is confirmed limited." }
  const routing = {
    select: async () => {
      calls.push("agent")
      return { status: "selected", selected: model, reasonCode: "highest-priority-eligible", reason: "Primary eligible.", skipped: [] }
    },
    selectPlan: async (plan: string) => {
      calls.push("plan:" + plan)
      if (plan === "missing") return { status: "no-plan", reasonCode: "unknown-plan", reason: "No model plan is configured with this name.", skipped: [] }
      if (plan === "empty") return {
        status: "no-eligible", reasonCode: "no-eligible", reason: "No candidate in the configured plan is eligible.",
        skipped: [skip], plan: { id: plan, source: "named-plan", reasonCode: "named-plan" },
      }
      return {
        status: "selected", selected: model, reasonCode: "highest-priority-eligible",
        reason: "Selected as the highest-priority eligible candidate.", skipped: [skip],
        plan: { id: plan, source: "named-plan", reasonCode: "named-plan" },
      }
    },
    explain: () => ({ status: "no-plan", reasonCode: "unbound-agent", reason: "No plan.", skipped: [] }),
    status: () => ({ apiVersion: 1, status: "ok", sources: {} }),
  }
  const testContext = context(routing)
  let listed = 0
  testContext.ctx.model.list = async () => { listed += 1; return { data: [] } }
  await testContext.register()
  const picked = await requestPlanSelection(testContext.ctx as never, { plan: "review" })
  assert.equal(picked.status, "selected")
  if (picked.status === "selected") {
    assert.deepEqual(picked.selected, model)
    assert.equal(picked.plan.id, "review")
    assert.equal(picked.plan.source, "named-plan")
    const firstSkip = picked.skipped[0] as { code?: string }
    assert.equal(firstSkip.code, "limited")
  }
  assert.deepEqual(calls, ["plan:review"])
  assert.equal(listed, 0, "plan selection does not list or assign models")
  assert.equal((await requestSelection(testContext.ctx as never, { agent: "reviewer" })).status, "selected")
  assert.equal((await requestPlanSelection(testContext.ctx as never, { plan: "missing" })).reasonCode, "unknown-plan")
  const exhausted = await requestPlanSelection(testContext.ctx as never, { plan: "empty" })
  assert.equal(exhausted.status, "no-eligible")
  if (exhausted.status === "no-eligible") assert.equal(exhausted.plan.id, "empty")
  assert.equal((await requestPlanSelection(testContext.ctx as never, { plan: " " })).reasonCode, "invalid-input")
  assert.equal((await requestPlanSelection(testContext.ctx as never, { plan: "review", agent: "reviewer" } as never)).reasonCode, "invalid-input")
  assert.deepEqual(calls.filter((call) => call.startsWith("plan:")), ["plan:review", "plan:missing", "plan:empty"])
  await assert.rejects(testContext.client().selectPlan({ plan: " " }), (error: Error & { code?: string }) => error.code === "invalid_input")
  await assert.rejects(testContext.client().selectPlan({ plan: "review", sessionID: "session" }), (error: Error & { code?: string }) => error.code === "invalid_input")
  const absent = context()
  await absent.register()
  assert.equal((await absent.client().selectPlan({ plan: "review" })).reasonCode, "unknown-plan")
  assert.equal((await absent.client().select({ agent: "reviewer" })).reasonCode, "unbound-agent")
  const bad = await requestPlanSelection({
    rpc: () => ({ selectPlan: async () => ({ status: "selected", apiVersion: 1, reasonCode: "ok", reason: "ok", selected: model, skipped: [], plan: { id: "review", source: "agent", reasonCode: "agent" } }) }),
  } as never, { plan: "review" })
  assert.equal(bad.reasonCode, "invalid-response")
  assert.equal((await requestPlanSelection({ rpc: () => { throw new Error("missing") } } as never, { plan: "review" })).reasonCode, "service-unavailable")
  let signal: AbortSignal | undefined
  const timed = await requestPlanSelection({
    rpc: () => ({ selectPlan: async (_input: unknown, options: { signal: AbortSignal }) => { signal = options.signal; return new Promise(() => {}) } }),
  } as never, { plan: "review" }, 5)
  assert.equal(timed.reasonCode, "timeout")
  assert.equal(signal?.aborted, true)
})
