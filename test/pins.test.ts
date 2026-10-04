import assert from "node:assert/strict"
import test from "node:test"
import { applyAgentRouting } from "../src/agent-routing.ts"
import { parseConfig } from "../src/config.ts"
import { explainSelection } from "../src/explain.ts"
import { AgentPins, PIN_STORAGE_KEY } from "../src/pins.ts"
import { modelKey, selectAgentModel } from "../src/select.ts"

const config = parseConfig({
  plans: { review: ["provider-a/primary", { id: "provider-b/backup", variant: "fast" }] },
  agents: { reviewer: "review" },
})
const primary = { providerID: "provider-a", modelID: "primary" }
const backup = { providerID: "provider-b", modelID: "backup", variant: "fast" }
const registry = [primary, backup]
const eligible = new Map(registry.map((model) => [modelKey(model), { status: "available" as const }]))

function storedPins(initial?: unknown) {
  let value = initial
  let key: string | undefined
  return {
    storage: {
      get: async () => value,
      set: async (storageKey: string, next: unknown) => { key = storageKey; value = next },
    },
    read: () => value,
    key: () => key,
  }
}

function agentEditor() {
  const agents = { reviewer: { id: "reviewer", model: { providerID: "host", id: "old" } } }
  return {
    agents,
    editor: {
      get: (id: string) => agents[id as keyof typeof agents] as never,
      update: (id: string, update: (agent: never) => void) => update(agents[id as keyof typeof agents] as never),
    },
  }
}

test("eligible pins persist across sessions and unpin restores plan order", async () => {
  const store = storedPins()
  const pins = await AgentPins.load(config, registry, store.storage)
  assert.deepEqual(await pins.pin("reviewer", { providerID: backup.providerID, modelID: backup.modelID }), backup)
  assert.equal(store.key(), PIN_STORAGE_KEY)
  assert.deepEqual(store.read(), { reviewer: backup })

  const restored = await AgentPins.load(config, registry, store.storage)
  const { editor, agents } = agentEditor()
  applyAgentRouting(editor as never, config, registry, eligible, 0, restored.snapshot())
  assert.deepEqual(agents.reviewer.model, { providerID: "provider-b", id: "backup", variant: "fast" })

  assert.equal(await restored.unpin("reviewer"), true)
  applyAgentRouting(editor as never, config, registry, eligible, 0, restored.snapshot())
  assert.deepEqual(agents.reviewer.model, { providerID: "provider-a", id: "primary" })
})

test("unknown models and unbound agents fail clearly; invalid stored pins are ignored", async () => {
  const store = storedPins({
    reviewer: { providerID: "missing", modelID: "model" },
    unbound: { providerID: "provider-a", modelID: "primary" },
  })
  const pins = await AgentPins.load(config, registry, store.storage)
  assert.equal(pins.get("reviewer"), undefined)
  assert.equal(pins.get("unbound"), undefined)
  await assert.rejects(pins.pin("reviewer", { providerID: "provider-z", modelID: "unknown" }), /not a candidate/)
  await assert.rejects(pins.pin("unbound", primary), /no configured plan/)
  const disabled = await AgentPins.load(config, [backup], store.storage)
  await assert.rejects(disabled.pin("reviewer", primary), /not enabled/)
})

for (const action of ["pin", "unpin"] as const) {
  test(`${action} rejects an unbound toString agent without changing pins or storage`, async () => {
    const initial = { reviewer: backup, toString: primary }
    const store = storedPins(initial)
    const pins = await AgentPins.load(config, registry, store.storage)
    assert.equal(pins.get("toString"), undefined)
    await assert.rejects(
      action === "pin" ? pins.pin("toString", primary) : pins.unpin("toString"),
      /agents\.toString: agent has no configured plan/,
    )
    assert.deepEqual([...pins.snapshot()], [["reviewer", backup]])
    assert.equal(store.read(), initial)
    assert.equal(store.key(), undefined)
  })
}

test("explicit toString agent and plan bindings can be pinned, restored, and unpinned", async () => {
  const namedConfig = parseConfig({
    plans: { toString: ["provider-a/primary"] },
    agents: { toString: "toString" },
  })
  const store = storedPins()
  const pins = await AgentPins.load(namedConfig, registry, store.storage)
  assert.deepEqual(await pins.pin("toString", primary), primary)
  assert.deepEqual(store.read(), { toString: primary })
  const restored = await AgentPins.load(namedConfig, registry, store.storage)
  assert.deepEqual(restored.get("toString"), primary)
  assert.equal(await restored.unpin("toString"), true)
  assert.equal(restored.get("toString"), undefined)
  assert.deepEqual(store.read(), {})
})

test("unavailable pins are skipped with structured reasons", async () => {
  const pins = await AgentPins.load(config, registry, storedPins().storage)
  await pins.pin("reviewer", backup)
  const unavailable = new Map([
    [modelKey(primary), { status: "limited" as const }],
    [modelKey(backup), { status: "unknown" as const }],
  ])
  const selection = selectAgentModel(config, "reviewer", registry, unavailable, 0, pins.get("reviewer"))
  assert.equal(selection.status, "no-eligible")
  const explanation = explainSelection(selection)
  assert.equal(explanation.status, "no-eligible")
  assert.match(explanation.reason, /No candidate/)
  assert.deepEqual(explanation.skipped.map(({ code }) => code), ["unknown", "limited"])
})

test("a recovered pinned model takes priority again on a later selection", async () => {
  const pins = await AgentPins.load(config, registry, storedPins().storage)
  await pins.pin("reviewer", backup)

  const unavailable = new Map([
    [modelKey(primary), { status: "available" as const }],
    [modelKey(backup), { status: "limited" as const }],
  ])
  const fallback = selectAgentModel(config, "reviewer", registry, unavailable, 0, pins.get("reviewer"))
  assert.equal(fallback.status, "selected")
  if (fallback.status === "selected") assert.deepEqual(fallback.model, primary)
  assert.deepEqual(explainSelection(fallback).skipped.map(({ code }) => code), ["limited"])

  const recovered = selectAgentModel(config, "reviewer", registry, eligible, 1, pins.get("reviewer"))
  assert.equal(recovered.status, "selected")
  if (recovered.status === "selected") {
    assert.deepEqual(recovered.model, backup)
    assert.equal(recovered.reason.code, "manual-pin")
  }
})
