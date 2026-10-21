import assert from "node:assert/strict"
import test from "node:test"
import { parseConfig } from "../src/config.ts"
import { registerAgentRouting } from "../src/agent-routing.ts"

interface Hook {
  (input: {
    sessionID: string
    kind?: string
    agent?: string
    model?: { providerID: string; id: string }
    decision?: { retry: boolean; delay?: number }
    error?: { status?: number }
    response?: { status: number; headers: { get(name: string): string | null } }
  }): Promise<void>
}

interface GenerateInput {
  prompt: string
  model?: { id: string; providerID: string; variant?: string } | null
}

async function harness(generate: (input: GenerateInput) => Promise<{ text: string }>) {
  const hooks: Record<string, Hook[]> = {}
  const stored = new Map<string, unknown>()
  const probes: GenerateInput[] = []
  const sessions = new Map<string, { agent: string; model: { providerID: string; id: string } }>([
    ["a", { agent: "reviewer", model: { providerID: "provider-a", id: "primary" } }],
  ])
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
    generate: {
      text: async (input: GenerateInput) => {
        probes.push(input)
        return generate(input)
      },
    },
    session: {
      hook: async (name: string, callback: Hook) => {
        hooks[name] ??= []
        hooks[name].push(callback)
        return { dispose: async () => {} }
      },
      get: async (input: { sessionID: string }) => ({ data: sessions.get(input.sessionID) }),
      switchModel: async (input: { sessionID: string; model: { providerID: string; id: string } }) => {
        sessions.set(input.sessionID, { agent: "reviewer", model: input.model })
      },
    },
    event: { subscribe: () => (async function* () {})() },
  } as never, config)
  return { hooks, sessions, probes, stored, routing }
}

const config = parseConfig({
  plans: { review: ["provider-a/primary", "provider-b/backup"] },
  agents: { reviewer: "review" },
  providerCooldownMs: 300_000,
  probeIntervalMs: 300_000,
  probeMaxBackoffMs: 3_600_000,
  probeRateLimits: ["provider-a/primary"],
  sharedRateLimits: [["provider-a/primary", "provider-b/backup"]],
})

const settle = async () => {
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 1))
}

test("a recovered model is cleared by one probe, without a network call of its own", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] })
  const fetches: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    fetches.push(String(input))
    throw new Error("the probe must not reach the network")
  }) as typeof globalThis.fetch
  t.after(() => { globalThis.fetch = original })

  const { probes, routing } = await harness(async () => ({ text: "OK" }))
  assert.equal(await routing?.reportFailure({
    providerID: "provider-a", modelID: "primary", classification: "temporary-rate-limit",
  }), true)
  const cooling = await routing?.diagnoseSession("a")
  assert.deepEqual((cooling?.failureCooldowns as { modelID?: string }[]).map((entry) => entry.modelID).sort(), ["backup", "primary"])

  t.mock.timers.tick(300_000)
  await settle()

  assert.equal(probes.length, 1, "the probe must be one separate generation")
  assert.equal(probes[0].model?.providerID, "provider-a")
  assert.equal(probes[0].model?.id, "primary")
  assert.equal(probes[0].prompt, "Reply with OK.")
  assert.deepEqual(fetches, [], "the probe must not open a network connection of its own")

  const report = await routing?.diagnoseSession("a")
  assert.deepEqual(report?.failureCooldowns, [], "a recovered bucket must leave the cooldown")
  assert.deepEqual(report?.rateLimitProbes?.map((entry) => entry.outcome), ["success"])
  assert.equal((report?.rateLimitProbes as { providerID: string }[])[0].providerID, "provider-a")
  await routing?.dispose()
})

test("a probe that is still limited does not extend the cooldown", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] })
  const { probes, stored, routing } = await harness(async () => {
    throw { type: "provider.rate-limit", status: 429, message: "OpenCode Zen: Rate limit exceeded." }
  })
  assert.equal(await routing?.reportFailure({
    providerID: "provider-a", modelID: "primary", classification: "temporary-rate-limit",
  }), true)
  const persisted = stored.get("availability/cooldowns-v1")

  t.mock.timers.tick(300_000)
  await settle()

  assert.equal(probes.length, 1)
  const report = await routing?.diagnoseSession("a")
  assert.deepEqual(report?.rateLimitProbes?.map((entry) => entry.outcome), ["still-limited"])
  assert.deepEqual(report?.failureCooldowns, [],
    "a probe must not extend the cooldown of the model or of its shared group")
  assert.equal(stored.get("availability/cooldowns-v1"), persisted,
    "a probe must not move the persisted deadline")
  await routing?.dispose()
})

test("a probe is not sent while a primary request is running", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] })
  const { hooks, probes, routing } = await harness(async () => ({ text: "OK" }))

  // A primary request is in flight.
  for (const callback of hooks["model.request"]) {
    await callback({ sessionID: "a", kind: "primary", agent: "reviewer", model: { providerID: "provider-a", id: "primary" } })
  }
  assert.equal(await routing?.reportFailure({
    providerID: "provider-a", modelID: "primary", classification: "temporary-rate-limit",
  }), true)

  t.mock.timers.tick(300_000)
  await settle()
  assert.equal(probes.length, 0, "no probe may run next to a real request")
  await routing?.dispose()
})
