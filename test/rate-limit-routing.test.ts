import assert from "node:assert/strict"
import test from "node:test"
import { parseConfig } from "../src/config.ts"
import { registerAgentRouting } from "../src/agent-routing.ts"

const config = parseConfig({
  plans: { review: ["provider-a/primary", "provider-b/backup"] },
  agents: { reviewer: "review" },
  providerCooldownMs: 100,
})

interface Hook {
  (input: {
    sessionID: string
    kind?: string
    agent?: string
    model?: { providerID: string; id: string }
    decision?: { retry: boolean; delay?: number }
    error?: { type?: string; status?: number; retryAfterMs?: number }
    response?: { status: number; headers: { get(name: string): string | null } }
  }): Promise<void>
}

async function harness() {
  const hooks: Record<string, Hook[]> = {}
  const stored = new Map<string, unknown>()
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
  return { hooks, sessions, routing }
}

const response = (status: number, headers: Record<string, string>) => ({
  status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
})

test("a provider-stated reset extends the cooldown the failure report applies", async () => {
  const { hooks, routing } = await harness()
  const now = Date.now()

  // The provider says this bucket is closed for the next hour.
  for (const callback of hooks["http.response"]) {
    await callback({
      sessionID: "a",
      kind: "primary",
      agent: "reviewer",
      model: { providerID: "provider-a", id: "primary" },
      response: response(429, { "retry-after": "3600" }),
    })
  }
  for (const callback of hooks["model.request"]) {
    await callback({ sessionID: "a", kind: "primary", agent: "reviewer", model: { providerID: "provider-a", id: "primary" } })
  }
  await hooks.retry[0]({
    sessionID: "a", agent: "reviewer", model: { providerID: "provider-a", id: "primary" },
    decision: { retry: true, delay: 500 }, error: { status: 429 },
  })

  const report = await routing?.diagnoseSession("a")
  const cooldown = (report?.failureCooldowns ?? []).find((entry: { modelID?: string }) => entry.modelID === "primary")
  assert.ok(cooldown, "the failed model must be cooling")
  assert.ok(
    (cooldown.until as number) >= now + 3_500_000,
    `the cooldown must reach the provider's stated reset, got ${cooldown.until}`,
  )
  await routing?.dispose()
})

test("the provider's stated rate-limit state is readable without sending anything", async () => {
  const { hooks, routing } = await harness()

  for (const callback of hooks["http.response"]) {
    await callback({
      sessionID: "a",
      kind: "primary",
      agent: "reviewer",
      model: { providerID: "provider-a", id: "primary" },
      response: response(429, { "retry-after": "60", "x-ratelimit-remaining-requests": "0" }),
    })
  }

  const report = await routing?.diagnoseSession("a")
  const signals = report?.providerRateLimits as Array<{ modelID: string; status?: number; remaining?: number; resetAt?: number }> | undefined
  assert.equal(signals?.length, 1)
  assert.equal(signals?.[0].modelID, "primary")
  assert.equal(signals?.[0].status, 429)
  assert.equal(signals?.[0].remaining, 0)
  assert.ok((signals?.[0].resetAt ?? 0) > Date.now(), "the stated reset must be in the future")
  await routing?.dispose()
})

test("a response without rate-limit headers leaves the state untouched", async () => {
  const { hooks, routing } = await harness()

  for (const callback of hooks["http.response"]) {
    await callback({
      sessionID: "a",
      kind: "primary",
      agent: "reviewer",
      model: { providerID: "provider-a", id: "primary" },
      response: response(200, { "content-type": "application/json" }),
    })
  }

  const report = await routing?.diagnoseSession("a")
  assert.deepEqual(report?.providerRateLimits, [])
  await routing?.dispose()
})

test("a free-allowance failure waits for the reset its error states", async () => {
  const { hooks, routing } = await harness()
  const now = Date.now()

  // The host does not retry this failure; the error carries when the allowance frees again.
  for (const callback of hooks["model.request"]) {
    await callback({ sessionID: "a", kind: "primary", agent: "reviewer", model: { providerID: "provider-a", id: "primary" } })
  }
  await hooks.retry[0]({
    sessionID: "a", agent: "reviewer", model: { providerID: "provider-a", id: "primary" },
    decision: { retry: false },
    error: { type: "provider.free-limit", status: 429, retryAfterMs: 3_600_000 },
  })

  const report = await routing?.diagnoseSession("a")
  const cooldown = (report?.failureCooldowns ?? []).find((entry: { modelID?: string }) => entry.modelID === "primary")
  assert.ok(cooldown, "the exhausted free model must be cooling")
  assert.ok(
    (cooldown.until as number) >= now + 3_500_000,
    `the cooldown must reach the stated reset, got ${cooldown.until}`,
  )
  await routing?.dispose()
})
