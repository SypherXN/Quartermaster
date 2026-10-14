import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { registerAgentRouting } from "../src/agent-routing.ts"
import { parseConfig } from "../src/config.ts"
import { LocalHealth } from "../src/local-health.ts"
import { modelKey } from "../src/select.ts"
import { registerQuartermasterRpc } from "../src/rpc.ts"

async function install(projectID = "a", stored = new Map<string, unknown>(), options: unknown = {
  plans: { review: ["local/primary", "remote/backup"] }, agents: { reviewer: "review" },
}) {
  const commands: Record<string, { execute(input: { sessionID: string }): Promise<void> }> = {}
  const hooks: Record<string, (input: unknown) => Promise<void>> = {}
  const sessions = new Map<string, unknown>([
    ["same", { projectID, agent: "reviewer", model: { providerID: "host", id: "manual", variant: "reasoning" }, secret: "never-print" }],
    ["other", { projectID, agent: "reviewer", model: { providerID: "host", id: "default" } }],
    ["unbound", { projectID, agent: "builder", model: { providerID: "host", id: "default" } }],
  ])
  let result: { text: string; resume: boolean; delivery: string; sessionID: string }
  let outputs = 0
  let handlers: Record<string, (input: unknown, call: never) => Promise<unknown>>
  const writes: string[] = []
  const calls = { switch: 0, reload: 0, registry: 0, rpc: 0 }
  const config = parseConfig(options)
  const context = {
    app: { name: "opencode", version: "2.0.25", channel: "stable" },
    location: { project: { id: projectID } },
    agent: { transform: async () => ({ dispose: async () => {} }), reload: async () => { calls.reload++ } },
    model: { list: async () => {
      calls.registry++
      return { data: [{ providerID: "local", id: "primary", enabled: true }, { providerID: "remote", id: "backup", enabled: true }] }
    } },
    rpc: Object.assign(() => ({ status: async () => { calls.rpc++; throw new Error("secret-upstream-error") } }), {
      register: async (_definition: unknown, methods: typeof handlers) => { handlers = methods; return { dispose: async () => {} } },
    }),
    storage: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: unknown) => { writes.push(key); stored.set(key, value) },
      remove: async (key: string) => { writes.push(key); stored.delete(key) },
    },
    command: { transform: async (callback: (editor: { add(command: typeof commands[string] & { name: string }): void }) => void) => {
      callback({ add: (command) => { commands[command.name] = command } })
      return { dispose: async () => {} }
    } },
    session: {
      hook: async (name: string, callback: typeof hooks[string]) => { hooks[name] = callback; return { dispose: async () => {} } },
      get: async ({ sessionID }: { sessionID: string }) => {
        if (!sessions.has(sessionID)) throw new Error("secret-session-error")
        return { data: sessions.get(sessionID) }
      },
      switchModel: async () => { calls.switch++ },
      synthetic: async (input: typeof result) => { outputs++; result = input },
    },
  }
  const routing = await registerAgentRouting(context as never, config)
  await registerQuartermasterRpc(context as never, config, routing)
  const diagnose = async (sessionID = "same") => {
    const before = { calls: { ...calls }, writes: [...writes], stored: [...stored], sessions: [...sessions] }
    await commands["qm-status"].execute({ sessionID })
    assert.equal(result!.resume, false)
    assert.equal(result!.delivery, "queue")
    assert.equal(result!.sessionID, sessionID)
    const count = outputs
    const immediate = await handlers!.diagnoseSession({ sessionID }, {} as never)
    assert.equal(outputs, count, "RPC must not enqueue diagnostic output")
    assert.equal((immediate as { runtime: { pluginInstanceID: string } }).runtime.pluginInstanceID, JSON.parse(result!.text).runtime.pluginInstanceID)
    assert.deepEqual({ calls, writes, stored: [...stored], sessions: [...sessions] }, before, "diagnostics must not refresh, switch, reload, poll, or persist routing state")
    assert.doesNotMatch(result!.text, /secret-|never-print/)
    return JSON.parse(result!.text)
  }
  return { routing: routing!, commands, diagnose, hooks, sessions, config, context }
}

test("qm-status separates snapshot recommendations, host selection and request observations", async () => {
  const fixture = await install()
  try {
    const first = await fixture.diagnose()
    assert.match(first.plugin.version, /^\d+\.\d+\.\d+/)
    assert.equal(first.runtime.host.version, "2.0.25")
    assert.equal(first.runtime.processID, process.pid)
    assert.equal(first.session.mode, "automatic")
    assert.equal(first.session.scope, "confirmed-project")
    assert.equal(first.session.model.variant, "reasoning")
    assert.equal(first.session.plan.id, "review")
    assert.equal(first.availability.quota, "unconfigured")
    assert.equal(first.recommendation.selected.providerID, "local")
    assert.equal(first.primaryRequestEvidence.lastObserved, "unknown")
    assert.ok(first.availability.snapshotReadAt > 0)
    assert.ok(first.availability.snapshotAgeMs >= 0)
    await fixture.hooks["model.request"]({ sessionID: "same", agent: "reviewer", kind: "title", model: { providerID: "aux", id: "title" } })
    assert.equal((await fixture.diagnose()).primaryRequestEvidence.lastObserved, "unknown")
    await fixture.hooks["model.request"]({ sessionID: "same", agent: "reviewer", kind: "primary", model: { providerID: "remote", id: "backup" } })
    const observed = await fixture.diagnose()
    assert.equal(observed.primaryRequestEvidence.lastObserved.model.modelID, "backup")
    assert.equal(observed.session.activePrimary, true)
    assert.match(observed.primaryRequestEvidence.basis, /not proof/)
  } finally { await fixture.routing.dispose() }
})

test("qm-status reads persisted manual opt-out without changing it across projects, sessions or reloads", async () => {
  const stored = new Map<string, unknown>()
  const first = await install("a", stored)
  await first.commands["qm-manual"].execute({ sessionID: "same" })
  const identity = (await first.diagnose()).runtime.pluginInstanceID
  await first.routing.dispose()
  const a = await install("a", stored)
  const b = await install("b", stored)
  try {
    const manual = await a.diagnose()
    assert.equal(manual.session.mode, "manual")
    assert.equal(manual.recommendation.applies, false)
    assert.notEqual(manual.runtime.pluginInstanceID, identity)
    assert.equal((await a.diagnose("other")).session.mode, "automatic")
    assert.equal((await b.diagnose()).session.mode, "automatic")
    assert.equal((await b.diagnose()).location.projectID, "b")
    await a.commands["qm-auto"].execute({ sessionID: "same" })
    assert.equal((await a.diagnose()).session.mode, "automatic")
  } finally { await a.routing.dispose(); await b.routing.dispose() }
})

test("qm-status labels unbound, missing plan, missing catalog and unavailable metadata", async () => {
  const fixture = await install()
  try {
    const unbound = await fixture.diagnose("unbound")
    assert.equal(unbound.session.mode, "unbound")
    assert.equal(unbound.session.binding, "unbound")
    assert.equal(unbound.recommendation.status, "no-plan")
    delete fixture.config.plans.review
    assert.equal((await fixture.diagnose()).session.binding, "missing-plan")
    fixture.config.plans.review = [{ providerID: "missing", modelID: "not-enabled" }]
    assert.equal((await fixture.diagnose()).recommendation.skipped[0].code, "not-in-registry")
    fixture.sessions.set("foreign", { projectID: "different-project", agent: "private-agent", model: { providerID: "private", id: "secret-model" } })
    const foreign = await fixture.diagnose("foreign")
    assert.equal(foreign.session.scope, "mismatch")
    assert.equal(foreign.session.agent, "unknown")
    assert.equal(foreign.session.model, "unknown")
    assert.equal(foreign.session.activePrimary, "unknown")
    assert.doesNotMatch(JSON.stringify(foreign), /private-agent|secret-model/)
    const unknown = await fixture.diagnose("missing-session")
    assert.equal(unknown.session.read, "unavailable")
    assert.equal(unknown.session.agent, "unknown")
    assert.equal(unknown.session.mode, "unknown")
    fixture.context.app = undefined as never
    assert.equal((await fixture.diagnose()).runtime.host, "unknown")
    assert.equal((await fixture.diagnose()).location.directory, "unknown")
    fixture.context.storage.get = async () => { throw new Error("secret-storage-error") }
    assert.equal((await fixture.diagnose()).session.mode, "unknown")
  } finally { await fixture.routing.dispose() }
  const empty = await install("empty", new Map(), {})
  try { assert.equal((await empty.diagnose()).session.mode, "unbound") }
  finally { await empty.routing.dispose() }
})

test("qm-status reuses offline health and injected availability without probing or revealing endpoints", async () => {
  const probe = mock.method(LocalHealth.prototype, "checkAll", async () => new Map([["local", "offline" as const]]))
  const fixture = await install("health", new Map(), {
    plans: { review: ["local/primary", "remote/backup"] }, agents: { reviewer: "review" },
    localEndpoints: { local: "http://127.0.0.1:8080/secret-endpoint" },
    usageSources: { local: "go" },
  })
  try {
    const count = probe.mock.callCount()
    assert.ok(count > 0, "bootstrap health must use the mock")
    const report = await fixture.diagnose()
    assert.equal(report.availability.localHealth.local, "offline")
    assert.equal(report.availability.quota, "unavailable")
    assert.equal(report.recommendation.skipped[0].code, "local-offline")
    assert.equal(report.recommendation.selected.providerID, "remote")
    assert.equal(probe.mock.callCount(), count, "status must not probe or force quota reads")
    await fixture.routing.refresh(new Map([
      [modelKey({ providerID: "local", modelID: "primary" }), { status: "available" }],
      [modelKey({ providerID: "remote", modelID: "backup" }), { status: "available" }],
    ]))
    assert.equal((await fixture.diagnose()).recommendation.selected.providerID, "local")
  } finally { await fixture.routing.dispose(); probe.mock.restore() }
})
