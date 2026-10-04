import assert from "node:assert/strict"
import test from "node:test"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import { applyAgentRouting, registerAgentRouting } from "../src/agent-routing.ts"
import { parseConfig } from "../src/config.ts"
import { modelKey, type ModelEligibility } from "../src/select.ts"
import { TokenBudgetGate } from "../src/telemetry/budget-gate.ts"
import type { TokenTelemetryRecord } from "../src/telemetry/types.ts"

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
  assert.deepEqual((await routing?.explain("reviewer"))?.skipped.map(({ code }) => code), ["limited"])

  await routing?.refresh(availability("available"))
  assert.deepEqual(agents.reviewer.model, { providerID: "provider-a", id: "primary" })
  assert.equal((await routing?.explain("reviewer"))?.reason, "Selected because this model is pinned for the agent.")
  assert.equal(await routing?.unpin("reviewer"), true)
  assert.equal((await routing?.explain("reviewer"))?.reason, "Selected as the highest-priority eligible candidate.")
  assert.deepEqual(calls, [
    "models", "transform", "reload", "reload", "reload", "models", "reload", "reload", "models", "reload", "reload",
  ])

  await routing?.dispose()
  assert.equal(calls.at(-1), "dispose")
})
