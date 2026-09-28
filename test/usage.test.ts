import assert from "node:assert/strict"
import test from "node:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { normalizeUsageSnapshot, readUsageStatus, USAGE_RPC } from "../src/usage.ts"

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

test("reads status with an empty input and abort signal, never forcing refresh", async () => {
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
