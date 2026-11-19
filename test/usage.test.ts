import assert from "node:assert/strict"
import test from "node:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import {
  normalizeUsageSnapshot, readUsageStatus, USAGE_RPC,
} from "../src/usage.ts"
import { buildQuotaEligibility } from "../src/eligibility.ts"
import { parseConfig } from "../src/config.ts"

const time = new Date().toISOString()
const resetAt = new Date(Date.parse(time) + 86_400_000).toISOString()

function source(availability: "available" | "limited" | "unknown" = "available"): Record<string, unknown> {
  const limited = availability === "limited"
  return {
    authenticated: true,
    checkedAt: time,
    stale: false,
    error: null,
    windows: [{
      name: "weekly",
      usedPercent: limited ? 100 : 40,
      state: limited ? "rate-limited" : "ok",
      resetsAt: limited ? resetAt : null,
      ...(limited ? { resetEstimated: true } : {}),
    }],
    nextAvailableAt: limited ? resetAt : null,
    availability,
  }
}

function snapshot() {
  return {
    schemaVersion: 1,
    updatedAt: time,
    sources: { go: source(), codex: source("limited"), cursor: source("unknown") },
    models: { go: {} },
  }
}

test("normalizes available, limited and unknown sources with reset data", () => {
  const result = normalizeUsageSnapshot(snapshot(), Date.parse(time))
  assert.equal(result.status, "ok")
  if (result.status !== "ok") return

  assert.equal(result.snapshot.sources.go.availability, "available")
  assert.equal(result.snapshot.sources.codex.availability, "limited")
  assert.equal(result.snapshot.sources.codex.windows[0].resetEstimated, true)
  assert.equal(result.snapshot.sources.codex.nextAvailableAt, Date.parse(resetAt))
  assert.equal(result.snapshot.sources.cursor.availability, "unknown")
})

test("Claude quota is additive, validated, and blocks only on fresh limits", () => {
  const config = parseConfig({ usageSources: { "claude-agent": "claude-agent" } })
  const data = snapshot()
  const claude = source("limited")
  const normalize = () => normalizeUsageSnapshot({ ...data, sources: { ...data.sources, "claude-agent": claude } }, Date.parse(time))
  const result = normalize()
  assert.equal(result.status, "ok")
  if (result.status !== "ok") return
  assert.equal(result.snapshot.sources["claude-agent"]?.availability, "limited")
  const model = { providerID: "claude-agent", modelID: "test-model" }
  assert.equal([...buildQuotaEligibility([model], config.usageSources, [], result).values()][0].status, "limited")
  claude.stale = true
  const stale = normalize()
  assert.equal(stale.status, "ok")
  if (stale.status !== "ok") return
  assert.equal(stale.snapshot.sources["claude-agent"]?.availability, "unknown")
  assert.equal([...buildQuotaEligibility([model], config.usageSources, [], stale).values()][0].status, "available")
  const legacy = normalizeUsageSnapshot(data, Date.parse(time))
  assert.equal(legacy.status, "ok")
  if (legacy.status === "ok") assert.equal(legacy.snapshot.sources["claude-agent"], undefined)
  claude.checkedAt = "invalid"
  assert.equal(normalize().status, "unavailable")
})

test("stale, unauthenticated, and errored sources cannot remain limited", () => {
  const data = snapshot()
  data.sources.go.stale = true
  data.sources.codex.checkedAt = new Date(Date.parse(time) - 6 * 60_000).toISOString()
  data.sources.cursor.authenticated = false
  data.sources.cursor.error = "authentication failed"
  const result = normalizeUsageSnapshot(data, Date.parse(time))

  assert.equal(result.status, "ok")
  if (result.status !== "ok") return
  for (const id of ["go", "codex", "cursor"] as const) {
    assert.equal(result.snapshot.sources[id].availability, "unknown")
    assert.equal(result.snapshot.sources[id].stale, true)
  }
})

test("schema versions and malformed timestamps fail explicitly", () => {
  assert.deepEqual(normalizeUsageSnapshot({ ...snapshot(), schemaVersion: 2 }), {
    status: "unavailable",
    reason: "schema-mismatch",
  })

  const data = snapshot()
  data.sources.go.checkedAt = "not a timestamp"
  assert.deepEqual(normalizeUsageSnapshot(data), {
    status: "unavailable",
    reason: "invalid-snapshot",
    path: "sources.go.checkedAt",
  })
})

function rpcContext(status: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>) {
  return {
    rpc: (definition: unknown) => {
      assert.equal((definition as { id: string }).id, USAGE_RPC.id)
      return { status }
    },
  } as unknown as Pick<Context, "rpc">
}

test("reads status with an empty input and abort signal while every source is fresh", async () => {
  let input: unknown
  let signal: AbortSignal | undefined
  const ctx = rpcContext(async (received, options) => {
    input = received
    signal = options?.signal
    return snapshot()
  })

  const result = await readUsageStatus(ctx)
  assert.deepEqual(input, {})
  assert.ok(signal instanceof AbortSignal)
  assert.equal(result.status, "ok")
})

test("a stale source asks for one refresh and keeps the newer reading per source", async () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const stale = (checkedAt: string) => ({ ...source(), checkedAt })

  const inputs: unknown[] = []
  let call = 0
  const ctx = rpcContext(async (input) => {
    inputs.push(input)
    call += 1
    if (call === 1) {
      return {
        schemaVersion: 1,
        updatedAt: minutesAgo(10),
        sources: { go: stale(minutesAgo(10)), codex: stale(minutesAgo(8)), cursor: stale(minutesAgo(0)) },
        models: { go: {} },
      }
    }
    // The poll refreshed go but lost codex, so the merge must keep the cached codex.
    return {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      sources: { go: stale(minutesAgo(0)), codex: stale(minutesAgo(30)), cursor: stale(minutesAgo(30)) },
      models: { go: {} },
    }
  })

  const result = await readUsageStatus(ctx)
  assert.equal(result.status, "ok")
  if (result.status !== "ok") return
  assert.deepEqual(inputs, [{}, { refresh: true }])
  assert.equal(result.snapshot.sources.go.stale, false, "the refreshed source replaces the stale reading")
  assert.equal(result.snapshot.sources.codex.stale, true, "a source the poll lost keeps the older observation")
})

test("a stale source whose refresh fails keeps the cached snapshot", async () => {
  const old = new Date(Date.now() - 10 * 60_000).toISOString()
  let call = 0
  const ctx = rpcContext(async () => {
    call += 1
    if (call > 1) throw new Error("refresh failed")
    return {
      schemaVersion: 1,
      updatedAt: old,
      sources: { go: { ...source(), checkedAt: old }, codex: { ...source(), checkedAt: old }, cursor: { ...source(), checkedAt: old } },
      models: { go: {} },
    }
  })

  const result = await readUsageStatus(ctx)
  assert.equal(result.status, "ok")
  if (result.status !== "ok") return
  assert.equal(result.snapshot.sources.go.stale, true)
  assert.equal(call, 2)
})

test("an equal-clock refresh cannot degrade a fresh source into stale", async () => {
  // A poll for one stale source re-reports another at the same observation clock,
  // now with an error. The cached fresh, limited reading must survive, and the
  // equal-clock path must still accept a genuine freshness recovery.
  const staleGo = new Date(Date.now() - 10 * 60_000).toISOString()
  let call = 0
  const ctx = rpcContext(async () => {
    call += 1
    if (call === 1) {
      return {
        schemaVersion: 1,
        updatedAt: time,
        sources: { go: { ...source(), checkedAt: staleGo }, codex: source("limited"), cursor: source("unknown") },
        models: { go: {} },
      }
    }
    return {
      schemaVersion: 1,
      updatedAt: time,
      sources: {
        go: { ...source(), checkedAt: staleGo, error: "poll failed" },
        codex: { ...source("limited"), error: "poll failed" },
        cursor: source("unknown"),
      },
      models: { go: {} },
    }
  })

  const result = await readUsageStatus(ctx)
  assert.equal(result.status, "ok")
  if (result.status !== "ok") return
  assert.equal(call, 2)
  assert.equal(result.snapshot.sources.go.stale, true, "the poll's failed observation still wins for its own clock")
  assert.equal(result.snapshot.sources.codex.stale, false, "an equal-clock failure does not replace fresh evidence")
  assert.equal(result.snapshot.sources.codex.availability, "limited", "and the limit stays visible to routing")

  // Equal clock, but the newer reading is the healthy one: recovery is accepted.
  let recovery = 0
  const recovering = rpcContext(async () => {
    recovery += 1
    return recovery === 1
      ? {
        schemaVersion: 1,
        updatedAt: time,
        sources: { go: { ...source(), checkedAt: staleGo }, codex: { ...source("limited"), error: "poll failed" }, cursor: source("unknown") },
        models: { go: {} },
      }
      : {
        schemaVersion: 1,
        updatedAt: time,
        sources: { go: { ...source(), checkedAt: staleGo }, codex: source("limited"), cursor: source("unknown") },
        models: { go: {} },
      }
  })
  const recovered = await readUsageStatus(recovering)
  assert.equal(recovered.status, "ok")
  if (recovered.status !== "ok") return
  assert.equal(recovered.snapshot.sources.codex.stale, false, "an equal-clock success clears an earlier failure")
  assert.equal(recovered.snapshot.sources.codex.error, null)
})

test("missing RPC and timeout are explicit and bounded", async () => {
  const missing = await readUsageStatus(rpcContext(async () => { throw new Error("not found") }))
  assert.deepEqual(missing, { status: "unavailable", reason: "rpc-error" })

  let signal: AbortSignal | undefined
  const hanging = rpcContext(async (_input, options) => {
    signal = options?.signal
    return new Promise(() => {})
  })
  const timeout = await readUsageStatus(hanging, 5)
  assert.deepEqual(timeout, { status: "unavailable", reason: "timeout" })
  assert.equal(signal?.aborted, true)
})
