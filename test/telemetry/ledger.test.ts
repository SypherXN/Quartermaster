import assert from "node:assert/strict"
import test from "node:test"
import type { Schema } from "effect"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { TokenLedger } from "../../src/telemetry/ledger.ts"
import type { TokenTelemetryRecord } from "../../src/telemetry/types.ts"

class MemoryStorage implements StorageDomain {
  values = new Map<string, Schema.Json>()
  failNextSet = false

  async get(key: string) {
    return this.values.get(key)
  }

  async set(key: string, value: Schema.Json) {
    if (this.failNextSet) {
      this.failNextSet = false
      throw new Error("synthetic write failure")
    }
    this.values.set(key, value)
  }

  async remove(key: string) {
    this.values.delete(key)
  }

  async scan(options: Parameters<StorageDomain["scan"]>[0]) {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(options.prefix) && (!options.after || key > options.after))
      .sort()
    const limit = options.limit ?? 100
    const keysPage = keys.slice(0, limit)
    return {
      entries: keysPage.map((key) => ({ key, value: this.values.get(key)! })),
      ...(keys.length > limit && keysPage.length ? { next: keysPage[keysPage.length - 1] } : {}),
    }
  }
}

function record(hostEventID: string, projectID: string | null, completedAt = 2_000_000_000_000): TokenTelemetryRecord {
  return {
    hostContractVersion: "2.0.18",
    hostEventID,
    sourceEvent: "session.step.ended",
    hostSessionID: `session-${projectID ?? "unknown"}`,
    hostMessageID: `message-${hostEventID}`,
    hostProjectID: projectID,
    parentSessionID: null,
    hostAgentID: null,
    providerID: null,
    modelID: null,
    variant: null,
    completedAt,
    counts: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    usageStatus: "reported",
    partial: false,
  }
}

test("upserts replayed and revised host events across ledger instances", async () => {
  const storage = new MemoryStorage()
  const first = new TokenLedger(storage)
  await first.ingest(record("event-1", "project-a"))

  const revised = record("event-1", "project-a")
  revised.counts = { ...revised.counts!, output: 7 }
  await new TokenLedger(storage).ingest(revised)
  await new TokenLedger(storage).ingest(revised)

  const rows = await new TokenLedger(storage).list({ projectID: "project-a" })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].counts?.output, 7)
})

test("concurrent project writes remain isolated and missing project stays explicit", async () => {
  const storage = new MemoryStorage()
  const left = new TokenLedger(storage)
  const right = new TokenLedger(storage)
  await Promise.all([
    left.ingest(record("event-a", "project-a")),
    right.ingest(record("event-b", "project-b")),
    left.ingest({ ...record("event-unknown", null), counts: null, usageStatus: "missing" }),
  ])

  assert.deepEqual((await left.list({ projectID: "project-a" })).map((row) => row.hostEventID), ["event-a"])
  assert.deepEqual((await right.list({ projectID: "project-b" })).map((row) => row.hostEventID), ["event-b"])
  const unknown = await left.list({ projectID: null })
  assert.equal(unknown[0].hostProjectID, null)
  assert.equal(unknown[0].counts, null)
  assert.equal(unknown[0].usageStatus, "missing")
})

test("retries failed writes, keeps every row inside the window, and folds an expired row into its lifetime total", async () => {
  const storage = new MemoryStorage()
  const now = 2_000_000_000_000
  const ledger = new TokenLedger(storage, { now: () => now, retentionMs: 100 })

  storage.failNextSet = true
  await assert.rejects(ledger.ingest(record("event-failed", "project-a", now - 1)))
  await ledger.ingest(record("event-old", "project-a", now - 101))
  await ledger.ingest(record("event-new-1", "project-a", now - 3))
  await ledger.ingest(record("event-new-2", "project-b", now - 2))
  await ledger.ingest(record("event-new-3", "project-a", now - 1))

  const rows = await ledger.list()
  assert.deepEqual(rows.map((row) => row.hostEventID), ["event-new-1", "event-new-2", "event-new-3"])
  assert.deepEqual((await ledger.list({ projectID: "project-a" })).map((row) => row.hostEventID), ["event-new-1", "event-new-3"])
  assert.deepEqual((await ledger.list({ projectID: "project-b" })).map((row) => row.hostEventID), ["event-new-2"])
  // No row cap: only the expired row left, so three raw rows plus its lifetime total.
  assert.equal(storage.values.size, 4)
  assert.deepEqual(await ledger.listRollups({ projectID: "project-a" }), [])
  const lifetime = await ledger.listLifetime({ projectID: "project-a" })
  assert.equal(lifetime.length, 1)
  assert.equal(lifetime[0].records, 1)
  assert.equal(lifetime[0].observedTokens, 12)
  assert.equal(lifetime[0].providerID, null)
  assert.equal(lifetime[0].input, 10)
  assert.equal(lifetime[0].cacheRead, 0)
  assert.equal(lifetime[0].unknownCacheRecords, 0)
  assert.equal(lifetime[0].hostCostMissing, 1)
})

test("an expired row and a fresh row with the same combination share one lifetime total", async () => {
  const storage = new MemoryStorage()
  let now = 2_000_000_000_000
  const ledger = new TokenLedger(storage, { now: () => now, retentionMs: 100 })
  await ledger.ingest({ ...record("old-1", "project-a", now - 300), hostAgentID: "build" })
  now += 86_400_000
  await ledger.ingest({ ...record("old-2", "project-a", now - 200), hostAgentID: "build" })
  await ledger.ingest({ ...record("held", "project-a", now - 1), hostAgentID: "build" })

  const lifetime = await ledger.listLifetime({ projectID: "project-a" })
  assert.equal(lifetime.length, 1)
  assert.equal(lifetime[0].agentID, "build")
  assert.equal(lifetime[0].records, 2)
  assert.deepEqual((await ledger.list({ projectID: "project-a" })).map((row) => row.hostEventID), ["held"])
  // Re-pruning the same rows does not add them twice.
  await ledger.list({ projectID: "project-a" })
  assert.equal((await ledger.listLifetime({ projectID: "project-a" }))[0].records, 2)
})

test("host pruning scans once per day and keeps pending expiry in totals", async () => {
  const storage = new MemoryStorage()
  let scans = 0
  const scan = storage.scan.bind(storage)
  storage.scan = async (options) => { scans++; return scan(options) }
  let now = 2_000_000_000_000
  const ledger = new TokenLedger(storage, { now: () => now, retentionMs: 100 })
  await ledger.ingest(record("aging", "project-a", now))
  const initialScans = scans
  now += 86_400_000 - 1
  await ledger.ingest(record("fresh", "project-a", now))
  assert.equal(scans, initialScans)
  assert.equal((await ledger.list()).length, 2)
  assert.equal(scans, initialScans + 1) // The read scans; pruning does not.
  now += 1
  await ledger.list()
  assert.equal((await ledger.listLifetime())[0].records, 1)
  assert.deepEqual((await ledger.list()).map((row) => row.hostEventID), ["fresh"])
})

test("partial flag round-trips and defaults when omitted in storage", async () => {
  const storage = new MemoryStorage()
  const ledger = new TokenLedger(storage)
  const withPartial = { ...record("event-partial", "project-a"), partial: true }
  await ledger.ingest(withPartial)
  assert.equal((await ledger.list({ projectID: "project-a" }))[0].partial, true)

  const key = `quartermaster:telemetry:v1:${encodeURIComponent("event-legacy")}`
  storage.values.set(key, {
    ...record("event-legacy", "project-a"),
    partial: undefined,
  } as unknown as Schema.Json)
  delete (storage.values.get(key) as Record<string, unknown>).partial
  assert.equal((await ledger.list({ projectID: "project-a" })).find((row) => row.hostEventID === "event-legacy")?.partial, false)
})

test("stored and exported rows whitelist telemetry metadata", async () => {
  const storage = new MemoryStorage()
  const ledger = new TokenLedger(storage)
  const unsafe = { ...record("event-safe", "project-a"), prompt: "secret prompt", credentials: "secret" }
  await ledger.ingest(unsafe as TokenTelemetryRecord)

  assert.doesNotMatch(JSON.stringify([...storage.values.values()]), /secret/)
  assert.doesNotMatch(JSON.stringify(await ledger.list()), /secret|prompt|credentials/)
})
