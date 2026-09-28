import assert from "node:assert/strict"
import test from "node:test"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import { registerAgentRouting } from "../src/agent-routing.ts"
import { parseConfig } from "../src/config.ts"
import { normalizeUsageSnapshot, type UsageReadResult } from "../src/usage.ts"

const config = parseConfig({
  plans: { review: ["provider-a/primary", "provider-b/backup"] },
  agents: { reviewer: "review" },
  usageSources: { "provider-a": "codex" },
})
const checkedAt = new Date().toISOString()
const estimatedReset = new Date(Date.now() - 1_000).toISOString()

function snapshot(availability: "available" | "limited", stale = false) {
  const limited = availability === "limited"
  return {
    schemaVersion: 1,
    updatedAt: checkedAt,
    sources: Object.fromEntries(["go", "codex", "cursor"].map((id) => [id, {
      authenticated: true,
      checkedAt: stale ? new Date(Date.now() - 6 * 60_000).toISOString() : checkedAt,
      stale,
      error: null,
      availability: id === "codex" ? availability : "available",
      windows: [{
        name: "weekly",
        usedPercent: limited ? 100 : 20,
        state: id === "codex" && limited ? "rate-limited" : "ok",
        resetsAt: id === "codex" && limited ? estimatedReset : null,
        ...(id === "codex" && limited ? { resetEstimated: true } : {}),
      }],
      nextAvailableAt: id === "codex" && limited ? estimatedReset : null,
    }])),
    models: { go: {} },
  }
}

function usage(availability: "available" | "limited"): UsageReadResult {
  return normalizeUsageSnapshot(snapshot(availability))
}

function setup(initial: UsageReadResult, statusReply: () => Promise<unknown>, savedState?: unknown) {
  const agents: Record<string, Record<string, unknown>> = { reviewer: { id: "reviewer" } }
  const editor = {
    get: (id: string) => agents[id] as never,
    update: (id: string, update: (agent: never) => void) => update(agents[id] as never),
  } as unknown as AgentEditor
  let transform: ((editor: AgentEditor) => void) | undefined
  let reloads = 0
  let statusCalls = 0
  let persisted = savedState
  const ctx = {
    model: {
      list: async () => ({ data: [
        { providerID: "provider-a", id: "primary", enabled: true },
        { providerID: "provider-b", id: "backup", enabled: true },
      ] }),
    },
    storage: {
      get: async () => persisted,
      set: async (_key: string, value: unknown) => { persisted = value },
      remove: async () => {},
      scan: async () => ({ entries: [] }),
    },
    rpc: () => ({ status: async () => { statusCalls++; return statusReply() } }),
    agent: {
      transform: async (callback: (editor: AgentEditor) => void) => {
        transform = callback
        return { dispose: async () => {} }
      },
      reload: async () => { reloads++; transform?.(editor) },
    },
  }
  return {
    ctx,
    agents,
    get reloads() { return reloads },
    get statusCalls() { return statusCalls },
    get persisted() { return persisted },
    runTransform: () => transform?.(editor),
    start: () => registerAgentRouting(ctx as never, config, initial),
  }
}

test("reuses limited usage between refreshes and estimated reset cannot restore quota", async () => {
  let nextStatus = snapshot("limited")
  const app = setup(usage("limited"), async () => nextStatus)
  const routing = await app.start()

  assert.deepEqual(app.agents.reviewer.model, { providerID: "provider-b", id: "backup" })
  app.runTransform()
  app.runTransform()
  assert.equal(app.statusCalls, 0)

  assert.equal(await routing?.refresh(), false)
  assert.equal(app.statusCalls, 1)
  assert.deepEqual(app.agents.reviewer.model, { providerID: "provider-b", id: "backup" })
  assert.equal(app.reloads, 1)

  nextStatus = snapshot("available")
  assert.equal(await routing?.refresh(), true)
  assert.equal(app.statusCalls, 2)
  assert.deepEqual(app.agents.reviewer.model, { providerID: "provider-a", id: "primary" })
  assert.equal(app.reloads, 2)
  await routing?.dispose()
})

test("stale limited usage remains unknown rather than confirmed exhaustion", async () => {
  const staleUsage = normalizeUsageSnapshot(snapshot("limited", true))
  assert.equal(staleUsage.status, "ok")
  if (staleUsage.status === "ok") assert.equal(staleUsage.snapshot.sources.codex.availability, "unknown")
  const app = setup(staleUsage, async () => snapshot("limited", true))
  const routing = await app.start()

  assert.deepEqual(app.agents.reviewer.model, { providerID: "provider-b", id: "backup" })
  await routing?.dispose()
})

test("concurrent refreshes coalesce usage reads and agent reloads", async () => {
  let release!: (value: unknown) => void
  let started!: () => void
  const requestStarted = new Promise<void>((resolve) => { started = resolve })
  const app = setup(usage("limited"), async () => {
    started()
    return new Promise((resolve) => { release = resolve })
  })
  const routing = await app.start()

  const first = routing?.refresh()
  const second = routing?.refresh()
  await requestStarted
  assert.equal(app.statusCalls, 1)
  app.runTransform()
  app.runTransform()
  assert.deepEqual(app.agents.reviewer.model, { providerID: "provider-b", id: "backup" })
  release(snapshot("available"))
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.equal(app.statusCalls, 1)
  assert.equal(app.reloads, 2)
  await routing?.dispose()
})

test("cooldowns persist and restore on the next plugin instance", async () => {
  const first = setup(usage("available"), async () => snapshot("available"))
  const firstRouting = await first.start()
  await firstRouting?.reportFailure({ providerID: "provider-a", classification: "provider-outage" })
  assert.equal(Array.isArray((first.persisted as { cooldowns: unknown[] }).cooldowns), true)
  await firstRouting?.dispose()

  const restarted = setup(usage("available"), async () => snapshot("available"), first.persisted)
  const restartedRouting = await restarted.start()
  assert.deepEqual(restarted.agents.reviewer.model, { providerID: "provider-b", id: "backup" })
  await restartedRouting?.dispose()
})
